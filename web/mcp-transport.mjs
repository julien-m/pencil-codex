// A WebSocket-like adapter over the standard MCP Apps host bridge.
// No direct network access or fallback is attempted from the native view.
export function createMcpTransport(app, editor, { onmessage, onclose, onerror }) {
  let connectionId, stopped = false, readyState = 0;
  const outgoing = [];
  const call = async args => {
    const result = await app.callServerTool({ name: 'pencil_editor_bridge', arguments: args });
    if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text ?? 'MCP editor bridge failed');
    if (!result.structuredContent) throw new Error('MCP editor bridge returned no data');
    return result.structuredContent;
  };
  const socket = {
    get readyState() { return readyState; },
    send(text) {
      if (readyState !== 1) throw new Error('EDITOR_CHANNEL_CLOSED');
      outgoing.push(JSON.parse(text));
    },
    async close() {
      stopped = true; readyState = 3;
      if (connectionId) await call({ action: 'close', connectionId }).catch(() => {});
    }
  };
  void (async () => {
    try {
      const connected = await call({ action: 'connect', sessionId: editor.sessionId, editorToken: editor.editorToken });
      connectionId = connected.connectionId;
      if (stopped) { await socket.close(); return; }
      readyState = 1;
      while (!stopped) {
        const result = await call({ action: 'exchange', connectionId, messages: outgoing.splice(0) });
        if (stopped) break;
        for (const message of result.messages) onmessage({ data: JSON.stringify(message) });
      }
    } catch (error) {
      if (!stopped) { onerror(error); onclose(); }
      await socket.close();
    }
  })();
  return socket;
}
