/** Install a test client for the public pen:connect protocol in an embed page. */
export function installEmbedProbe({ uri, content }) {
  const channel = new MessageChannel();
  const pending = new Map();
  let sequence = 0;
  const probe = {
    ready: false, content, writes: 0, errors: [], notifications: [],
    async request(method, payload) {
      const id = `probe-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} exceeded 10 seconds`)); }, 10_000);
        pending.set(id, { resolve, reject, timer });
        channel.port1.postMessage({ kind: 'request', id, method, payload });
      });
    },
  };
  channel.port1.onmessage = async ({ data: message }) => {
    if (message.kind === 'ready') { probe.ready = true; return; }
    if (message.kind === 'error') { probe.errors.push(message); return; }
    if (message.kind === 'notification') { probe.notifications.push(message.method); return; }
    if (message.kind === 'response') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.payload);
      return;
    }
    if (message.kind !== 'request') return;
    let payload;
    switch (message.method) {
      case 'storage-load': payload = { filePath: uri.split('/').pop(), content: probe.content, updatedAt: Date.now() }; break;
      case 'storage-write': probe.content = message.payload.content; probe.writes++; payload = 0; break;
      case 'storage-has-asset': payload = false; break;
      case 'documents-save-preview': payload = null; break;
      default:
        channel.port1.postMessage({ kind: 'response', id: message.id, error: { code: 'PROBE_UNSUPPORTED', message: `Probe does not implement ${message.method}` } });
        return;
    }
    channel.port1.postMessage({ kind: 'response', id: message.id, payload });
  };
  channel.port1.start();
  window.penProbe = probe;
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.type !== 'pen:ready' || probe.connectSent) return;
    probe.connectSent = true;
    window.postMessage({ type: 'pen:connect', fileURI: uri, theme: 'dark', clientName: 'Feasibility probe' }, location.origin, [channel.port2]);
  });
  return { installed: true };
}
