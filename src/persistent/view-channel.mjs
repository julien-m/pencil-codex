/** Buffer early view messages behind renderer attachment, with a bounded queue. */
export function attachViewChannel(peer, watchReady, onSave, onOpenNative) {
  // A legacy panel has no mode switch. New panels explicitly opt into Hand before enabling controls.
  let queued = 0, editing = true, opening = false;
  const send = message => { if (peer.readyState === 1) peer.send(JSON.stringify(message)); };
  peer.on('error', () => {});
  peer.on('close', () => { void watchReady.then(watch => watch.close()).catch(() => {}); });
  peer.on('message', async bytes => {
    if (++queued > 100) { queued--; peer.close(1008, 'View input queue full'); return; }
    try {
      const message = JSON.parse(bytes.toString()), watch = await watchReady;
      if (peer.readyState !== 1) return;
      if (message.kind === 'frame-ack') watch.acknowledge(message.id);
      else if (message.kind === 'mode' && typeof message.editing === 'boolean') {
        editing = message.editing;
        if (!editing) await watch.cancelInput({ enteringHand: true });
      }
      else if (message.kind === 'input' && editing && !opening) {
        await watch.input(message.input, message.viewportRevision);
        send({ kind: 'input-result', id: message.id });
      }
      else if (message.kind === 'navigate' && !editing && !opening) await watch.navigate(message.navigation, message.viewportRevision);
      else if (message.kind === 'resize') await watch.resize(message.viewport);
      else if (message.kind === 'cancel-input') await watch.cancelInput();
      else if (message.kind === 'save' && editing && !opening) {
        await watch.cancelInput(); await onSave(); send({ kind: 'saved' });
      }
      else if (message.kind === 'open-native' && !opening) {
        opening = true;
        try { await watch.cancelInput(); await onOpenNative(onSave); send({ kind: 'native-opened' }); }
        catch (error) { send({ kind: 'native-open-failed', code: error.code, message: error.message }); }
        finally { opening = false; }
      }
      else throw new Error('Unsupported view message');
    } catch (error) { send({ kind: 'error', message: error.message }); }
    finally { queued--; }
  });
  void watchReady.catch(() => { send({ kind: 'error', message: 'Renderer unavailable' }); peer.close(); });
}
