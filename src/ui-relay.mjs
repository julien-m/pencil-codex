import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

// The app talks to its originating MCP server, not to a loopback URL.
// Only this Node-side transport opens the existing authenticated editor socket.
export class UiRelay {
  constructor({ idleTimeout = 15000, pollTimeout = 250, maxBytes = 40 * 1024 * 1024 } = {}) {
    this.connections = new Map();
    this.idleTimeout = idleTimeout; this.pollTimeout = pollTimeout; this.maxBytes = maxBytes;
  }
  async connect({ port, sessionId, editorToken }) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/editor?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(editorToken)}`, { maxPayload: this.maxBytes, handshakeTimeout: 2000 });
    const connectionId = randomUUID();
    const state = { socket, messages: [], bytes: 0, waiting: null, polling: false, closed: false };
    socket.on('error', () => {});
    socket.on('message', bytes => {
      if (state.bytes + bytes.length > this.maxBytes) { this.close(connectionId); return; }
      try {
        state.messages.push(JSON.parse(bytes.toString())); state.bytes += bytes.length;
        state.waiting?.();
      } catch { this.close(connectionId); }
    });
    socket.on('close', () => {
      state.closed = true; state.waiting?.();
    });
    this.connections.set(connectionId, state);
    this.touch(connectionId, state);
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return { connectionId, messages: [] };
    } catch (error) { this.close(connectionId); throw error; }
  }
  touch(id, state) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => this.close(id), this.idleTimeout);
    state.timer.unref();
  }
  async exchange(connectionId, messages = []) {
    const state = this.connections.get(connectionId);
    if (!state) throw new Error('EDITOR_CHANNEL_CLOSED');
    if (state.polling) throw new Error('EDITOR_EXCHANGE_IN_FLIGHT');
    state.polling = true; this.touch(connectionId, state);
    try {
      for (const message of messages) {
        if (state.socket.readyState !== WebSocket.OPEN) throw new Error('EDITOR_CHANNEL_CLOSED');
        state.socket.send(JSON.stringify(message));
      }
      if (!state.messages.length && !state.closed) await new Promise(resolve => {
        const timer = setTimeout(resolve, this.pollTimeout);
        state.waiting = () => { clearTimeout(timer); resolve(); };
      });
      if (state.closed) throw new Error('EDITOR_CHANNEL_CLOSED');
      const incoming = state.messages.splice(0); state.bytes = 0;
      return { messages: incoming };
    } finally { state.waiting = null; state.polling = false; }
  }
  close(connectionId) {
    const state = this.connections.get(connectionId);
    if (!state) return;
    this.connections.delete(connectionId); clearTimeout(state.timer);
    state.closed = true; state.waiting?.(); state.socket.terminate();
  }
  closeAll() { for (const id of this.connections.keys()) this.close(id); }
}
