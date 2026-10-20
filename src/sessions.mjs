import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeNewFile, replaceDocument, exportDirectory, writeExportFile } from './artifacts.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export class SessionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new SessionError(code, message); };

export class Sessions {
  constructor({ timeout = 15000, saveWaitTimeout = 5000, draftRoot = path.join(os.tmpdir(), 'pencil-panel-drafts') } = {}) { this.items = new Map(); this.timeout = timeout; this.saveWaitTimeout = saveWaitTimeout; this.draftRoot = draftRoot; }
  get(id) { return this.items.get(id) ?? fail('SESSION_NOT_FOUND', 'Session inconnue'); }
  async open(filename, scope) {
    if (!path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.pen') fail('INVALID_PATH', 'Un fichier .pen absolu est requis');
    const file = await fs.realpath(filename);
    if (path.extname(file).toLowerCase() !== '.pen') fail('INVALID_PATH', 'La cible réelle doit être un document .pen');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) fail('INVALID_FILE', 'Document invalide ou trop volumineux');
    const previous = [...this.items.values()].find(s => s.file === file);
    if (previous) {
      if (previous.scope !== scope) fail('DOCUMENT_BUSY', 'Ce document appartient déjà à une autre session ; créer une copie pour une variante');
      return this.status(previous.id);
    }
    const id = randomUUID();
    const draft = path.join(this.draftRoot, `${digest(`${scope}:${file}`)}.pen`);
    const s = { id, scope, file, draft, exportJobs: new Map(), mutationRevision: 0, virtualRoot: `pencil/${id}/`, generation: 0, pending: new Map(), agents: new Map(), blocked: false, connected: false, savedHash: null, operations: 0, saveState: 'not-loaded' };
    this.items.set(id, s);
    return this.status(id);
  }
  status(id) {
    const s = this.get(id);
    return { sessionId: s.id, scope: s.scope, name: path.basename(s.file), connected: s.connected, generation: s.generation, blocked: s.blocked, leaseOwner: [...s.agents.values()].map(a => a.agent).join(', ') || null, agents: [...s.agents.values()].map(a => ({ agent: a.agent, activeCalls: a.calls })), activeCalls: [...s.agents.values()].reduce((n, a) => n + a.calls, 0), saving: !!s.saving, operations: s.operations, saveState: s.saveState, draftPath: s.draft };
  }
  attach(id, send) {
    const s = this.get(id);
    if (s.connected) fail('EDITOR_ALREADY_CONNECTED', 'Une vue est déjà attachée à cette session');
    if (s.blocked) fail('OUTCOME_UNKNOWN', 'Réconciliation requise avant de reconnecter cette session');
    s.generation += 1; s.send = send; s.connected = true;
    return { generation: s.generation, fileURI: `file:///${s.virtualRoot}${encodeURIComponent(path.basename(s.file))}` };
  }
  detach(id, generation) {
    const s = this.get(id);
    if (generation !== s.generation) return;
    s.connected = false; s.send = undefined;
    for (const p of s.pending.values()) p.reject(new SessionError('OUTCOME_UNKNOWN', 'Connexion perdue pendant un appel'));
    if (s.pending.size) s.blocked = true;
    s.pending.clear();
  }
  acquire(id, agent) {
    const s = this.get(id);
    if (s.blocked) fail('OUTCOME_UNKNOWN', 'Session bloquée après un résultat inconnu');
    // The legacy lease field is now a non-exclusive participation token.
    const token = randomUUID();
    s.agents.set(token, { agent, calls: 0 });
    return { lease: token, ...this.status(id) };
  }
  release(id, token) {
    const s = this.get(id), participant = s.agents.get(token);
    if (!participant) fail('INVALID_LEASE', 'Participation invalide');
    if (participant.calls || s.saving) fail('CALLS_IN_FLIGHT', 'Des appels restent en cours');
    if (s.blocked) fail('OUTCOME_UNKNOWN', 'Ne pas terminer une participation avec une opération inconnue');
    s.agents.delete(token);
    return this.status(id);
  }
  call(id, token, name, args = {}, { observational = false } = {}) {
    const s = this.get(id), participant = s.agents.get(token);
    if (!participant) fail('INVALID_LEASE', 'Participation requise avant les appels');
    if (s.blocked) fail('OUTCOME_UNKNOWN', 'Session bloquée ; ne pas rejouer les mutations');
    if (s.saving) {
      participant.calls += 1; this.onActivity?.(id);
      let resumed = false;
      return this.afterSave(id, () => {
        participant.calls -= 1; resumed = true;
        return this.call(id, token, name, args, { observational });
      }).finally(() => { if (!resumed) participant.calls -= 1; this.onActivity?.(id); });
    }
    if (!['execute', 'read_skill', 'get_style', 'get_app_state'].includes(name)) fail('TOOL_NOT_ALLOWED', 'Outil non exposé par ce plugin');
    if (name === 'execute' && /\bGenerate\s*\(/.test(args.input ?? '')) fail('ASYNC_UNSUPPORTED', 'La génération asynchrone n’est pas prise en charge dans cette version');
    participant.calls += 1;
    const mutation = name === 'execute' && !observational;
    // Dispatch immediately: each request has its own response ID, no document queue.
    let result;
    try { result = this.request(id, 'mcp-tool-call', { name, arguments: args }); }
    catch (error) { participant.calls -= 1; throw error; }
    this.onActivity?.(id);
    return result.then(response => {
      s.operations += 1;
      return response;
    }).finally(() => {
      participant.calls -= 1;
      if (mutation) {
        s.mutationRevision += 1;
        if (s.saveState !== 'conflict') s.saveState = 'check-required';
      }
      this.onActivity?.(id);
    });
  }
  async afterSave(id, operation) {
    const s = this.get(id), deadline = Date.now() + this.saveWaitTimeout;
    while (s.saving) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail('SAVE_WAIT_TIMEOUT', 'Délai d’attente de sauvegarde dépassé ; aucun appel envoyé');
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new SessionError('SAVE_WAIT_TIMEOUT', 'Délai d’attente de sauvegarde dépassé ; aucun appel envoyé')), remaining);
        s.saveFinished.then(value => { clearTimeout(timer); resolve(value); });
      });
      if (result.error) throw result.error;
    }
    if (s.blocked) fail('OUTCOME_UNKNOWN', 'Session bloquée ; ne pas rejouer les mutations');
    return operation();
  }
  request(id, method, payload) {
    const s = this.get(id);
    if (s.saving && method !== 'save') return this.afterSave(id, () => this.request(id, method, payload));
    if (s.blocked) fail('OUTCOME_UNKNOWN', 'Session bloquée ; ne pas rejouer les mutations');
    if (!s.connected) fail('EDITOR_OFFLINE', 'Ouvrir le fichier .pen dans le panneau et attendre le moteur');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(requestId); s.blocked = true;
        reject(new SessionError('OUTCOME_UNKNOWN', 'Délai dépassé ; le résultat de l’opération est inconnu'));
      }, this.timeout);
      s.pending.set(requestId, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } });
      try { s.send({ kind: 'request', id: requestId, method, payload }); }
      catch (e) { clearTimeout(timer); s.pending.delete(requestId); s.blocked = true; reject(e); }
    });
  }
  reply(id, generation, message) {
    const s = this.get(id);
    if (generation !== s.generation) return false;
    const p = s.pending.get(message.id);
    if (!p) return false;
    s.pending.delete(message.id);
    if (message.error) p.reject(new SessionError('EDITOR_ERROR', String(message.error.message)));
    else p.resolve(message.payload);
    return true;
  }
  async capture(id, token, nodeIds, directory) {
    const target = await exportDirectory(directory);
    const result = await this.call(id, token, 'execute', { filePath: '', description: 'Capturer les éléments sélectionnés', input: `TakeScreenshot(${JSON.stringify(nodeIds)})` }, { observational: true });
    if (result.isError) return result;
    const files = [];
    for (const image of result.content.filter(x => x.type === 'image')) {
      if (image.mimeType !== 'image/png') fail('UNSUPPORTED_CAPTURE', 'Format de capture non pris en charge');
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('INVALID_CAPTURE', 'Capture PNG invalide');
      files.push(await writeNewFile(path.join(target, `pencil-${randomUUID()}.png`), bytes));
    }
    if (!files.length) fail('EMPTY_CAPTURE', 'Le moteur n’a retourné aucune image');
    return { ...result, structuredContent: { files } };
  }
  async exportNodes(id, token, nodeIds, format, directory) {
    const s = this.get(id), target = await exportDirectory(directory);
    const prefix = `images/pencil-export-${randomUUID()}`;
    const job = { directory: target, files: [] }; s.exportJobs.set(prefix, job);
    const output = format.startsWith('html-') ? `${prefix}/index.html` : prefix;
    try {
      const result = await this.call(id, token, 'execute', { filePath: '', description: 'Exporter la sélection', input: `Export(${JSON.stringify(nodeIds)},${JSON.stringify(format)},${JSON.stringify(output)})` }, { observational: true });
      if (result.isError) return { ...result, structuredContent: { files: job.files, partial: true } };
      if (!job.files.length) fail('EXPORT_NOT_SAVED', 'Le moteur a répondu sans produire de fichier vérifié');
      return { ...result, structuredContent: { files: job.files } };
    } finally { s.exportJobs.delete(prefix); }
  }
  async save(id, token) {
    const s = this.get(id);
    if (s.saving) return this.afterSave(id, () => this.save(id, token));
    if (!s.agents.has(token) || s.pending.size || [...s.agents.values()].some(a => a.calls) || s.blocked || s.saving) fail('SAVE_NOT_READY', 'Rejoindre la session et attendre la fin des opérations');
    let finishSave, saveError;
    s.saveFinished = new Promise(resolve => { finishSave = resolve; });
    s.saving = true; this.onActivity?.(id);
    try {
      // Ask the engine to flush its current content, including unsaved manual edits.
      const result = await this.request(id, 'save');
      if (result !== 0 && result !== 1) fail('SAVE_NOT_READY', 'Le moteur n’a pas confirmé la sauvegarde');
      return await this.persist(s, async () => {
        if (s.savedHash === null || s.saveState === 'conflict') fail('SAVE_CONFLICT', 'Le fichier a changé ; utiliser Enregistrer sous pour conserver le brouillon');
        let bytes;
        try { bytes = await fs.readFile(s.draft); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          if (digest(await fs.readFile(s.file)) !== s.savedHash) fail('SAVE_CONFLICT', 'Le fichier a changé');
          return { path: s.file, sessionId: id, unchanged: true };
        }
        try {
          const saved = await replaceDocument(s.file, bytes, s.savedHash);
          s.savedHash = digest(bytes); s.saveState = 'source-saved';
          await this.atomicWrite(`${s.draft}.baseline`, Buffer.from(JSON.stringify({ sourceHash: s.savedHash })));
          return { ...saved, sessionId: id };
        } catch (error) { if (error.code === 'SAVE_CONFLICT') s.saveState = 'conflict'; throw error; }
      });
    } catch (error) { saveError = error; throw error; }
    finally { s.saving = false; finishSave({ error: saveError }); this.onActivity?.(id); }
  }
  async saveAs(id, token, filename) {
    const s = this.get(id);
    if (s.saving) return this.afterSave(id, () => this.saveAs(id, token, filename));
    if (!s.agents.has(token) || s.pending.size || [...s.agents.values()].some(a => a.calls) || s.blocked || s.saving) fail('SAVE_NOT_READY', 'Rejoindre la session et attendre la fin des opérations');
    if (!['draft-saved', 'source-saved', 'conflict'].includes(s.saveState)) fail('SAVE_NOT_READY', 'Attendre un acquittement de sauvegarde du moteur avant Enregistrer sous');
    if (path.extname(filename).toLowerCase() !== '.pen') fail('INVALID_PATH', 'Choisir un nouveau fichier .pen');
    const saved = await writeNewFile(filename, await fs.readFile(s.draft));
    return { path: saved, sessionId: id, sourceUnchanged: true };
  }
  persist(s, operation) {
    const result = (s.persistenceTail ?? Promise.resolve()).then(operation);
    s.persistenceTail = result.catch(() => {});
    return result;
  }
  storage(id, generation, method, payload) {
    const s = this.get(id), revision = s.mutationRevision;
    // Capture at message arrival, before disk IO or the persistence queue can delay it.
    return this.persist(s, () => this.storageNow(id, generation, method, payload, revision));
  }
  async storageNow(id, generation, method, payload, revision) {
    const s = this.get(id);
    if (generation !== s.generation || !s.connected) fail('STALE_CHANNEL', 'Canal périmé');
    if (method === 'documents-save-preview') return null; // Optional dashboard thumbnail, no document persistence.
    if (method === 'storage-load') {
      let bytes = await fs.readFile(s.file);
      const sourceHash = digest(bytes); s.savedHash = sourceHash; s.saveState = 'saved';
      try {
        bytes = await fs.readFile(s.draft);
        // Persist the original revision across reloads/restarts. Legacy drafts
        // without a baseline are recoverable through Save As, not blind Save.
        try { s.savedHash = JSON.parse(await fs.readFile(`${s.draft}.baseline`, 'utf8')).sourceHash; }
        catch (error) { if (error.code !== 'ENOENT') throw error; s.savedHash = null; }
        s.saveState = s.savedHash === sourceHash ? 'draft-saved' : 'conflict';
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return { filePath: path.basename(s.file), content: bytes.toString('utf8'), updatedAt: (await fs.stat(s.file)).mtimeMs };
    }
    if (method === 'storage-write' || method === 'storage-save-draft') {
      if (typeof payload?.content !== 'string' || Buffer.byteLength(payload.content) > 32 * 1024 * 1024) fail('INVALID_CONTENT', 'Contenu invalide');
      if (payload.fileURI !== `file:///${s.virtualRoot}${encodeURIComponent(path.basename(s.file))}`) fail('WRONG_DOCUMENT', 'URI de document inattendue');
      let sourceHash;
      try { sourceHash = digest(await fs.readFile(s.file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const conflict = s.savedHash === null || sourceHash !== s.savedHash;
      // Autosave keeps a draft; only explicit Save publishes to the source path.
      await fs.mkdir(this.draftRoot, { recursive: true, mode: 0o700 });
      await this.atomicWrite(s.draft, Buffer.from(payload.content));
      await this.atomicWrite(`${s.draft}.baseline`, Buffer.from(JSON.stringify({ sourceHash: s.savedHash })));
      s.saveState = conflict ? 'conflict' : revision === s.mutationRevision ? 'draft-saved' : 'check-required'; return conflict ? 2 : 0;
    }
    if (!['storage-read-asset', 'storage-write-asset', 'storage-has-asset'].includes(method)) fail('METHOD_NOT_ALLOWED', `Opération de stockage inconnue : ${method}`);
    const key = payload?.path;
    if (typeof key !== 'string' || !key.startsWith(s.virtualRoot)) fail('ASSET_OUTSIDE_ROOT', 'Asset hors document');
    const relative = key.slice(s.virtualRoot.length);
    if (!relative || relative.split('/').some(x => !x || x === '..' || x === '.') || relative.includes('\\')) fail('ASSET_OUTSIDE_ROOT', 'Chemin asset invalide');
    if (!/^(images|fonts)\//.test(relative) || /\.pen$/i.test(relative)) fail('ASSET_OUTSIDE_ROOT', 'Seuls les assets images/ et fonts/ sont accessibles');
    const exportJob = [...s.exportJobs.entries()].find(([prefix]) => relative.startsWith(`${prefix}/`));
    if (exportJob && method === 'storage-write-asset') {
      const [prefix, job] = exportJob, exportPath = relative.slice(prefix.length + 1);
      const data = payload?.data;
      if (!Array.isArray(data) || data.length > 32 * 1024 * 1024 || !data.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) fail('INVALID_ASSET', 'Export invalide');
      job.files.push(await writeExportFile(job.directory, exportPath, Buffer.from(data)));
      return null;
    }
    const root = path.dirname(s.file), target = path.join(root, relative);
    if (target === s.file) fail('ASSET_IS_DOCUMENT', 'Un asset ne peut pas remplacer le document');
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) fail('ASSET_SYMLINK', 'Liens symboliques interdits pour les assets'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (method === 'storage-read-asset') { try { return [...await fs.readFile(target)]; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
    if (method === 'storage-has-asset') { try { await fs.access(target); return true; } catch { return false; } }
    const data = payload?.data;
    if (!Array.isArray(data) || data.length > 16 * 1024 * 1024 || !data.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) fail('INVALID_ASSET', 'Asset invalide');
    await fs.mkdir(path.dirname(target), { recursive: true }); await this.atomicWrite(target, Buffer.from(data));
    return null;
  }
  async atomicWrite(file, bytes) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
}
