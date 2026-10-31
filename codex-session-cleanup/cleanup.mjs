import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatPreview, formatResult, formatTextReport } from './output.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent',
  'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Rpc {
  constructor(entry, home) {
    this.pending = new Map(); this.sequence = 0; this.diagnostics = '';
    const script = /\.[cm]?js$/i.test(entry);
    this.proc = spawn(script ? process.execPath : entry, [...(script ? [entry] : []), 'app-server', '--listen', 'stdio://'], {
      env: { ...process.env, CODEX_HOME: home }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.proc.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) {
        // This client never approves server-initiated requests or starts a turn.
        if (message.method && message.id !== undefined) this.send({
          id: message.id, error: { code: -32601, message: 'Unsupported by cleanup client' },
        });
        return;
      }
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    });
    this.proc.stderr.on('data', chunk => {
      this.diagnostics = (this.diagnostics + chunk.toString()).slice(-6000);
    });
    const fail = error => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
    };
    this.proc.on('error', fail);
    this.proc.on('exit', code => fail(new Error(`Codex server exited (${code}): ${this.diagnostics}`)));
  }
  send(message) { this.proc.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Timed out: ${method}`));
      }, 120000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'codex_session_cleanup', title: 'Local session cleanup', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
  }
  close() { this.proc.stdin.end(); this.lines.close(); this.proc.kill(); }
}

export function locateCodex() {
  if (process.env.CODEX_CLEANUP_ENTRY) return process.env.CODEX_CLEANUP_ENTRY;
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ];
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    if (folder) candidates.push(path.join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  }
  const entry = candidates.find(p => fs.existsSync(p));
  if (!entry) throw new Error('Installed @openai/codex CLI not found. Set CODEX_CLEANUP_ENTRY.');
  if (process.platform === 'win32') {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const native = path.join(path.dirname(path.dirname(entry)), 'node_modules', '@openai',
      `codex-win32-${process.arch}`, 'vendor', `${arch}-pc-windows-msvc`, 'bin', 'codex.exe');
    if (fs.existsSync(native)) return native;
  }
  return entry;
}

function inside(root, file) {
  // Windows may return the same absolute location as C:\... or \\?\C:\....
  // Compare both paths in the native namespace; keep the original filesystem
  // path so extended-path semantics are not altered by string replacement.
  const relative = path.relative(path.toNamespacedPath(root), path.toNamespacedPath(file));
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

// Codex compresses older rollouts in place to <name>.jsonl.zst and keeps the
// .jsonl path in its database, so both spellings belong to the same session.
export const rolloutFiles = file => [file, file + '.zst'];

// Validate persisted report content without consulting the current filesystem.
export function resolveRolloutPath(thread, home) {
  if (!thread.path || !uuid.test(thread.id)) throw new Error(`Missing or invalid session path: ${thread.id}`);
  const file = path.resolve(thread.path);
  const roots = ['sessions', 'archived_sessions'].map(p => path.join(home, p));
  const root = roots.find(r => inside(r, file));
  if (!root || path.extname(file) !== '.jsonl' || !path.basename(file).includes(thread.id)) {
    throw new Error(`Unexpected rollout path: ${file}`);
  }
  return { file, root };
}

export function fileInfo(thread, home) {
  const { file, root } = resolveRolloutPath(thread, home);
  let bytes = 0, modified = 0, exists = false;
  for (const stored of rolloutFiles(file)) {
    let stat;
    try { stat = fs.lstatSync(stored); } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular rollout: ${stored}`);
    const realRoot = fs.realpathSync.native(root);
    // Session roots themselves must not be redirected to an unrelated directory.
    const realHome = fs.realpathSync.native(home);
    if (!inside(realHome, realRoot) || !inside(realRoot, fs.realpathSync.native(stored))) {
      throw new Error(`Rollout escapes Codex home: ${stored}`);
    }
    bytes += stat.size; modified = Math.max(modified, stat.mtimeMs / 1000); exists = true;
  }
  return { file, bytes, modified, exists };
}

export async function listAll(rpc, includeArchived = true, extra = {}) {
  const result = [];
  for (const archived of includeArchived ? [false, true] : [false]) {
    let cursor = null; const seen = new Set();
    do {
      const page = await rpc.request('thread/list', {
        limit: 100, cursor, archived, sourceKinds, sortKey: 'updated_at', sortDirection: 'asc', useStateDbOnly: true, ...extra,
      });
      if (!Array.isArray(page.data)) throw new Error('Unexpected thread/list response');
      result.push(...page.data.map(t => ({ ...t, archived })));
      cursor = page.nextCursor || null;
      if (cursor && seen.has(cursor)) throw new Error('Repeated pagination cursor');
      seen.add(cursor);
    } while (cursor);
  }
  return result;
}

export async function readPins(home) {
  const stateFile = path.join(home, '.codex-global-state.json');
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
    if (Object.hasOwn(state, 'pinned-thread-ids')) {
      const current = state['pinned-thread-ids'];
      if (!Array.isArray(current) || current.some(id => typeof id !== 'string' || !uuid.test(id))) {
        throw new Error('Cannot verify the current desktop pinned-thread list');
      }
      // This includes the intentional empty list after the user unpins everything.
      // Migration records describe previous imports, not current pin membership.
      return new Set(current);
    }
  }
  // For homes without a desktop pin list, use only the current state database.
  // Never treat migration history or an older state database as current pin state.
  const pins = new Set();
  const { DatabaseSync } = await import('node:sqlite');
  const name = fs.readdirSync(home).filter(n => /^state_\d+\.sqlite$/.test(n))
    .sort((a,b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  if (name) {
    const db = new DatabaseSync(path.join(home, name), { readOnly: true });
    try {
      const columns = db.prepare('PRAGMA table_info(threads)').all().map(c => c.name);
      if (!columns.length) throw new Error(`Cannot verify current thread metadata in ${name}`);
      if (!columns.includes('is_pinned')) throw new Error(`Cannot verify persisted pins in ${name}`);
      for (const row of db.prepare('SELECT id FROM threads WHERE is_pinned = 1').all()) pins.add(row.id);
    } finally { db.close(); }
  }
  return pins;
}

function parentId(t) {
  return t.parentThreadId || t.source?.subAgent?.thread_spawn?.parent_thread_id
    || t.source?.subagent?.thread_spawn?.parent_thread_id || null;
}

export function planCleanup(threads, pins, protectedIds, cutoff, home) {
  const byId = new Map(threads.map(t => [t.id, t]));
  const children = new Map();
  for (const t of threads) {
    const parent = parentId(t);
    if (parent) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(t.id);
    }
  }
  const reasons = new Map(); const info = new Map();
  for (const t of threads) {
    const why = [];
    if (pins.has(t.id) || t.isPinned === true) why.push('pinned');
    if (protectedIds.has(t.id)) why.push('explicitly-protected');
    if (t.ephemeral) why.push('ephemeral');
    if (t.status?.type !== 'notLoaded') why.push('loaded-or-running');
    if (!Number.isFinite(t.updatedAt) || t.updatedAt <= 0) why.push('missing-timestamp');
    try {
      const item = fileInfo(t, home); info.set(t.id, item);
      if (Math.max(t.updatedAt, t.recencyAt || 0, item.modified) >= cutoff) why.push('recent');
    } catch (e) { why.push('invalid-path: ' + e.message); }
    if (parentId(t) && !byId.has(parentId(t))) why.push('missing-parent');
    if (why.length) reasons.set(t.id, why);
  }
  const groups = []; const visited = new Set();
  for (const root of threads.filter(t => !parentId(t))) {
    const ids = []; const pending = [root.id];
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) throw new Error('Duplicate or cyclic thread family');
      visited.add(id); ids.push(id); pending.push(...(children.get(id) || []));
    }
    const protectedMembers = ids.filter(id => reasons.has(id));
    if (protectedMembers.length) continue;
    groups.push({ rootId: root.id, ids, bytes: ids.reduce((n, id) => n + info.get(id).bytes, 0),
      title: root.name || root.preview?.split('\n')[0]?.slice(0,120) || root.id,
      updatedAt: Math.max(...ids.map(id => Math.max(byId.get(id).updatedAt, byId.get(id).recencyAt || 0, info.get(id).modified))),
      files: ids.map(id => ({ id, ...info.get(id) })),
    });
  }
  return { groups, byId, info, reasons };
}

export async function recheckGroup(rpc, group, home, protectedIds, cutoff) {
  const pins = await readPins(home);
  const fresh = [];
  for (const archived of [false, true]) {
    let cursor = null;
    do {
      const page = await rpc.request('thread/list', { ancestorThreadId: group.rootId,
        archived, sourceKinds, limit: 100, cursor });
      fresh.push(...page.data); cursor = page.nextCursor || null;
    } while (cursor);
  }
  // Query the root separately without resuming it or modifying its activity date.
  let root;
  if (group.files.find(f => f.id === group.rootId)?.exists) {
    root = (await rpc.request('thread/read', { threadId: group.rootId, includeTurns: false })).thread;
  } else {
    // A missing rollout is explicitly supported by thread/delete. Read its latest
    // metadata without trying to resume or recreate the missing session file.
    const { DatabaseSync } = await import('node:sqlite');
    const name = fs.readdirSync(home).filter(n => /^state_\d+\.sqlite$/.test(n))
      .sort((a,b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
    if (!name) return { allowed: false, reason: 'missing-state-db' };
    const db = new DatabaseSync(path.join(home, name), { readOnly: true });
    let row;
    try { row = db.prepare('SELECT id,rollout_path,updated_at,recency_at,source,title,is_pinned FROM threads WHERE id = ?').get(group.rootId); }
    finally { db.close(); }
    if (!row) return { allowed: false, reason: 'already-removed' };
    let source = row.source;
    if (typeof source === 'string' && source.startsWith('{')) source = JSON.parse(source);
    root = { id: row.id, path: row.rollout_path, updatedAt: row.updated_at,
      recencyAt: row.recency_at, source, name: row.title, isPinned: Boolean(row.is_pinned),
      ephemeral: false, status: { type: 'notLoaded' } };
  }
  fresh.push(root);
  if (new Set(fresh.map(t => t.id)).size !== group.ids.length || fresh.some(t => !group.ids.includes(t.id))) {
    return { allowed: false, reason: 'family-changed' };
  }
  const plan = planCleanup(fresh, pins, protectedIds, cutoff, home);
  if (plan.groups.length !== 1 || plan.groups[0].ids.length !== group.ids.length) {
    return { allowed: false, reason: 'eligibility-changed' };
  }
  return { allowed: true, group: plan.groups[0] };
}

export async function run(options = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'));
  const home = path.resolve(options.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const days = options.days ?? config.days;
  if (!Number.isInteger(days) || days < 7) throw new Error('Retention must be at least 7 days');
  const cutoff = Date.now() / 1000 - days * 86400;
  const protectedIds = new Set(config.protectedIds || []);
  for (const id of [process.env.CODEX_THREAD_ID, process.env.CODEX_SESSION_ID]) if (id) protectedIds.add(id);
  if (options.protectFile) {
    const external = JSON.parse(fs.readFileSync(options.protectFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(external) || external.some(id => !uuid.test(id))) throw new Error('Invalid protection file');
    external.forEach(id => protectedIds.add(id));
  }
  // A host inventory is mandatory for unattended deletion against the real user home.
  // Freshly-started app-server processes cannot observe another server's loaded threads.
  if (options.apply && !options.protectFile) throw new Error('--apply requires --protect-file from the current desktop inventory');
  if (options.apply && Date.now() - fs.statSync(options.protectFile).mtimeMs > 5 * 60000) {
    throw new Error('Protection inventory is older than five minutes; refresh it first');
  }
  const reportDir = path.join(here, 'reports'); fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, new Date().toISOString().replace(/[:.]/g, '-') + (options.apply ? '-apply' : '-preview') + '.json');
  const rpc = new Rpc(options.entry || locateCodex(), home);
  const report = { startedAt: new Date().toISOString(), home, days, cutoff: new Date(cutoff * 1000).toISOString(),
    mode: options.apply ? 'apply' : 'preview', reportPath,
    textReportPath: reportPath.replace(/\.json$/, '.txt'), deleted: [], skipped: [], failed: [] };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const saveText = () => fs.writeFileSync(report.textReportPath, '\uFEFF' + formatTextReport(report), 'utf8');
  try {
    await rpc.initialize();
    const threads = await listAll(rpc, config.includeArchived);
    const pins = await readPins(home);
    const plan = planCleanup(threads, pins, protectedIds, cutoff, home);
    if (options.approvedGroups) {
      const approved = new Map(options.approvedGroups.map(g => [g.rootId, new Set(g.ids)]));
      plan.groups = plan.groups.filter(g => {
        const ids = approved.get(g.rootId);
        return ids && ids.size === g.ids.length && g.ids.every(id => ids.has(id));
      });
    }
    report.totalSessions = threads.length; report.pinned = pins.size;
    report.candidates = plan.groups;
    report.candidateSessions = plan.groups.reduce((n, g) => n + g.ids.length, 0);
    report.candidateBytes = plan.groups.reduce((n, g) => n + g.bytes, 0);
    report.protectedSessions = threads.length - report.candidateSessions;
    report.protectionReasons = {};
    for (const reasons of plan.reasons.values()) {
      for (const reason of reasons) {
        const key = reason.split(':')[0];
        report.protectionReasons[key] = (report.protectionReasons[key] || 0) + 1;
      }
    }
    save();
    saveText();
    if (options.output === 'json') console.log(JSON.stringify({ mode: report.mode, totalSessions: report.totalSessions,
      candidateFamilies: plan.groups.length, candidateSessions: report.candidateSessions,
      candidateGiB: +(report.candidateBytes / 2 ** 30).toFixed(3), protectedSessions: report.protectedSessions,
      protectionReasons: report.protectionReasons, reportPath }));
    else if (options.output !== 'quiet') console.log(formatPreview(report));
    if (options.apply) {
      for (const group of plan.groups) {
        try {
          const check = await recheckGroup(rpc, group, home, protectedIds, cutoff);
          if (!check.allowed) { report.skipped.push({ rootId: group.rootId, reason: check.reason }); save(); continue; }
          await rpc.request('thread/delete', { threadId: group.rootId });
          const remaining = check.group.files.flatMap(f => rolloutFiles(f.file)).filter(f => fs.existsSync(f));
          if (remaining.length) throw new Error('Deletion API returned but rollout files remain');
          report.deleted.push({ rootId: group.rootId, ids: group.ids, bytes: check.group.bytes });
          save();
        } catch (e) { report.failed.push({ rootId: group.rootId, error: e.message }); save(); }
      }
      const finalThreads = await listAll(rpc, config.includeArchived, { useStateDbOnly: true });
      const remainingIds = new Set(finalThreads.map(t => t.id));
      for (const deleted of report.deleted) {
        if (deleted.ids.some(id => remainingIds.has(id))) report.failed.push({ rootId: deleted.rootId, error: 'Metadata still present after deletion' });
      }
    }
    report.finishedAt = new Date().toISOString(); save();
    saveText();
    if (options.output === 'json') console.log(JSON.stringify({ deletedSessions: report.deleted.reduce((n,g) => n + g.ids.length, 0),
      freedGiB: +(report.deleted.reduce((n,g) => n + g.bytes, 0) / 2 ** 30).toFixed(3),
      skippedFamilies: report.skipped.length, failedFamilies: report.failed.length, reportPath }));
    else if (options.apply && options.output !== 'quiet') console.log(formatResult(report));
    if (report.failed.length) throw new Error(`Some deletions failed; inspect ${reportPath}`);
    return report;
  } catch (e) {
    report.error = e.message;
    // Callers need the successful groups even when deletion or final verification fails.
    e.report = report;
    save(); saveText(); throw e;
  }
  finally { rpc.close(); }
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') result.apply = true;
    else if (args[i] === '--json') result.output = 'json';
    else if (['--home', '--days', '--protect-file'].includes(args[i])) {
      const key = { '--home': 'home', '--days': 'days', '--protect-file': 'protectFile' }[args[i]];
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing ${key}`);
      result[key] = key === 'days' ? Number(value) : value;
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(parseArgs(process.argv.slice(2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
