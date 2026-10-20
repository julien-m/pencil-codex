import { encodeMessage, MessageDecoder, BRIDGE_BATCH_CHUNKS } from '../shared/bridge-wire.mjs';

// The host proxies separate receive and send calls. A quiet long poll must not
// delay an engine reply or a Save request in the other direction.
export function createMcpTransport(app, editor, { onmessage, onclose, onerror }) {
  let connectionId, stopped = false, readyState = 0, sending = false;
  const outgoing = [], decoder = new MessageDecoder();
  const call = async args => {
    const result = await app.callServerTool({ name: 'pencil_editor_bridge', arguments: args });
    if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text ?? 'MCP editor bridge failed');
    if (!result.structuredContent) throw new Error('MCP editor bridge returned no data');
    return result.structuredContent;
  };
  const fail = async error => {
    if (!stopped) { onclose(); onerror(error); }
    await socket.close();
  };
  const flush = async () => {
    if (sending || stopped || !connectionId) return;
    sending = true;
    try {
      while (outgoing.length && !stopped) await call({ action: 'send', connectionId, messages: outgoing.splice(0, BRIDGE_BATCH_CHUNKS) });
    } catch (error) { await fail(error); }
    finally { sending = false; }
  };
  const socket = {
    get readyState() { return readyState; },
    send(text) {
      if (readyState !== 1) throw new Error('EDITOR_CHANNEL_CLOSED');
      outgoing.push(...encodeMessage(JSON.parse(text)));
      void flush();
    },
    async close() {
      stopped = true; readyState = 3;
      if (connectionId) { const closed = connectionId; connectionId = undefined; await call({ action: 'close', connectionId: closed }).catch(() => {}); }
    }
  };
  void (async () => {
    try {
      const connected = await call({ action: 'connect', sessionId: editor.sessionId, editorToken: editor.editorToken });
      connectionId = connected.connectionId;
      if (stopped) { await socket.close(); return; }
      readyState = 1;
      while (!stopped) {
        const result = await call({ action: 'exchange', connectionId });
        if (stopped) break;
        for (const chunk of result.messages) {
          const message = decoder.accept(chunk);
          if (message !== undefined) onmessage({ data: JSON.stringify(message) });
        }
      }
    } catch (error) { await fail(error); }
  })();
  return socket;
}
