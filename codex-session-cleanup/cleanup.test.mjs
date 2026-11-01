import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { planCleanup, listAll, readPins, recheckGroup, Rpc, locateCodex, run } from './cleanup.mjs';
import { manual } from './manual.mjs';

const now = Date.now() / 1000;
const cutoff = now - 7 * 86400;
const old = now - 8 * 86400;
const recent = now - 86400;

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cleanup-test-'));
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'archived_sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6.1-sol"\n');
  return home;
}

function thread(home, { id = randomUUID(), updatedAt = old, parent = null, archived = false,
  pinned = false, status = 'notLoaded', modified = updatedAt } = {}) {
  const timestamp = new Date(updatedAt * 1000).toISOString();
  const dir = archived ? path.join(home, 'archived_sessions')
    : path.join(home, 'sessions', ...timestamp.slice(0,10).split('-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${timestamp.slice(0,19).replace(/:/g, '-')}-${id}.jsonl`);
  const source = parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } : 'cli';
  const lines = [
    { timestamp, type: 'session_meta', payload: { id, timestamp, cwd: home,
      originator: 'codex_session_cleanup_test', cli_version: '0.160.0', source, model_provider: 'openai' } },
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic cleanup test only', images: [], local_images: [], text_elements: [] } },
  ];
  fs.writeFileSync(file, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.utimesSync(file, modified, modified);
  return { id, updatedAt, createdAt: updatedAt, recencyAt: updatedAt, parentThreadId: parent,
    source, path: file, isPinned: pinned, status: { type: status }, ephemeral: false, name: id, archived };
}

test('seven-day cutoff, runtime status, explicit pins, and modified rollouts are protected', () => {
  const home = fixture();
  const eligible = thread(home), pinned = thread(home, { pinned: true });
  const entries = [eligible, thread(home, { updatedAt: recent }), pinned,
    thread(home, { status: 'active' }), thread(home, { modified: recent }), thread(home, { updatedAt: cutoff })];
  const explicit = thread(home); entries.push(explicit);
  const p = planCleanup(entries, new Set([pinned.id]), new Set([explicit.id]), cutoff, home);
  assert.deepEqual(p.groups.map(g => g.rootId), [eligible.id], JSON.stringify([...p.reasons]));
});

test('a protected or recent descendant protects its entire family', () => {
  const home = fixture();
  const root = thread(home), child = thread(home, { parent: root.id, updatedAt: recent });
  assert.equal(planCleanup([root, child], new Set(), new Set(), cutoff, home).groups.length, 0);
  child.updatedAt = old; child.recencyAt = old; fs.utimesSync(child.path, old, old);
  assert.equal(planCleanup([root, child], new Set([child.id]), new Set(), cutoff, home).groups.length, 0);
  const p = planCleanup([root, child], new Set(), new Set(), cutoff, home);
  assert.equal(p.groups.length, 1); assert.equal(p.groups[0].ids.length, 2);
});

// Mirrors Codex, which compresses old rollouts in place and keeps their modified time.
// keepPlain leaves the .jsonl as well, as during an unfinished compression.
function compress(t, modified = t.updatedAt, keepPlain = false) {
  fs.writeFileSync(t.path + '.zst', zlib.zstdCompressSync(fs.readFileSync(t.path)));
  fs.utimesSync(t.path + '.zst', modified, modified);
  if (!keepPlain) fs.unlinkSync(t.path);
}

test('compressed rollouts count as existing logs and keep recent-session protection', () => {
  const home = fixture();
  const compressed = thread(home), both = thread(home), newer = thread(home);
  const plainNewer = thread(home, { modified: recent }), compressedNewer = thread(home);
  compress(compressed); compress(newer, recent);
  compress(both, old, true); compress(plainNewer, old, true); compress(compressedNewer, recent, true);
  const p = planCleanup([compressed, both, newer, plainNewer, compressedNewer], new Set(), new Set(), cutoff, home);
  assert.deepEqual(p.groups.map(g => g.rootId), [compressed.id, both.id], JSON.stringify([...p.reasons]));
  assert.equal(p.groups[0].bytes, fs.statSync(compressed.path + '.zst').size);
  assert.equal(p.groups[0].files[0].exists, true);
  assert.equal(p.groups[1].bytes, fs.statSync(both.path).size + fs.statSync(both.path + '.zst').size);
  // With both spellings present, the newer of the two decides recency.
  for (const t of [newer, plainNewer, compressedNewer]) assert(p.reasons.get(t.id).includes('recent'));
});

test('missing parent and paths outside the sessions directory cannot be deleted', () => {
  const home = fixture();
  const orphan = thread(home, { parent: randomUUID() });
  const escaped = thread(home); escaped.path = path.join(home, 'config.toml');
  assert.equal(planCleanup([orphan, escaped], new Set(), new Set(), cutoff, home).groups.length, 0);
});

test('Windows extended paths preserve eligibility and recent-session protection', { skip: process.platform !== 'win32' }, () => {
  const home = fixture();
  const eligible = thread(home), newer = thread(home, { updatedAt: recent });
  eligible.path = path.toNamespacedPath(eligible.path);
  newer.path = path.toNamespacedPath(newer.path);
  const p = planCleanup([eligible, newer], new Set(), new Set(), cutoff, home);
  assert.deepEqual(p.groups.map(g => g.rootId), [eligible.id], JSON.stringify([...p.reasons]));
  assert(p.groups[0].bytes > 0);
  assert(p.reasons.get(newer.id).includes('recent'));
  assert(!p.reasons.get(newer.id).some(r => r.startsWith('invalid-path')));
});

test('Windows extended paths outside the session roots and junction escapes remain excluded', { skip: process.platform !== 'win32' }, () => {
  const home = fixture(), outside = fixture();
  const escaped = thread(outside);
  escaped.path = path.toNamespacedPath(escaped.path);
  assert.equal(planCleanup([escaped], new Set(), new Set(), cutoff, home).groups.length, 0);
  const link = path.join(home, 'sessions', 'outside-link');
  fs.symlinkSync(path.dirname(escaped.path), link, 'junction');
  const throughLink = { ...escaped, path: path.toNamespacedPath(path.join(link, path.basename(escaped.path))) };
  assert.equal(planCleanup([throughLink], new Set(), new Set(), cutoff, home).groups.length, 0);
  // A compressed rollout behind the junction has no .jsonl, so only the .zst check can exclude it.
  const compressedEscape = thread(outside); compress(compressedEscape);
  const compressedLink = { ...compressedEscape,
    path: path.toNamespacedPath(path.join(link, path.basename(compressedEscape.path))) };
  assert.equal(planCleanup([compressedLink], new Set(), new Set(), cutoff, home).groups.length, 0);
});

test('all source kinds and archived pages are paginated, with repeated cursors rejected', async () => {
  let calls = 0;
  const rpc = { request: async (_method, params) => {
    calls++; assert(params.sourceKinds.includes('appServer')); assert(params.sourceKinds.includes('subAgent'));
    return { data: [{ id: `${params.archived}-${params.cursor || 'first'}` }], nextCursor: params.cursor ? null : 'next' };
  } };
  assert.equal((await listAll(rpc)).length, 4); assert.equal(calls, 4);
  await assert.rejects(listAll({ request: async () => ({ data: [], nextCursor: 'repeat' }) }), /Repeated/);
});

test('pin state is refreshed immediately before deletion', async () => {
  const home = fixture(), root = thread(home);
  const group = planCleanup([root], new Set(), new Set(), cutoff, home).groups[0];
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'pinned-thread-ids': [root.id] }));
  const rpc = { request: async method => method === 'thread/read' ? { thread: root } : { data: [], nextCursor: null } };
  assert.equal((await recheckGroup(rpc, group, home, new Set(), cutoff)).allowed, false);
});

test('current desktop pins override migration history, including an empty current list', async () => {
  const home = fixture(), current = randomUUID(), old = randomUUID();
  const statePath = path.join(home, '.codex-global-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ 'pinned-thread-ids': [current],
    'app-server-migrated-pinned-thread-ids-by-host': { local: [current, old] } }));
  assert.deepEqual([...await readPins(home)], [current]);
  fs.writeFileSync(statePath, JSON.stringify({ 'pinned-thread-ids': [],
    'app-server-migrated-pinned-thread-ids-by-host': { local: [old] } }));
  assert.equal((await readPins(home)).size, 0);
});

test('without desktop state only the latest database supplies current pins', async () => {
  const home = fixture(), current = randomUUID(), old = randomUUID();
  const { DatabaseSync } = await import('node:sqlite');
  for (const [version, id] of [[4, old], [5, current]]) {
    const db = new DatabaseSync(path.join(home, `state_${version}.sqlite`));
    try { db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, is_pinned INTEGER)');
      db.prepare('INSERT INTO threads VALUES (?,1)').run(id); }
    finally { db.close(); }
  }
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({
    'app-server-migrated-pinned-thread-ids-by-host': { local: [old] } }));
  assert.deepEqual([...await readPins(home)], [current]);
});

test('planning and missing-rollout rechecks share the selected pin authority', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  for (const mode of ['desktop-empty', 'desktop-pinned', 'db-only']) await t.test(mode, async () => {
    const home = fixture(), root = thread(home, { pinned: true });
    fs.unlinkSync(root.path); // Only this disposable synthetic rollout is removed.
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at REAL,
      recency_at REAL, source TEXT, title TEXT, is_pinned INTEGER)`);
    db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,1)').run(root.id, root.path, old, old, 'cli', 'fixture');
    db.close();
    if (mode !== 'db-only') fs.writeFileSync(path.join(home, '.codex-global-state.json'),
      JSON.stringify({ 'pinned-thread-ids': mode === 'desktop-pinned' ? [root.id] : [] }));
    const approved = planCleanup([root], new Set(), new Set(), cutoff, home).groups[0];
    assert.ok(approved); // A stale thread.isPinned cannot bypass the selected pin set.
    const plan = planCleanup([root], await readPins(home), new Set(), cutoff, home);
    const rpc = { request: async () => ({ data: [], nextCursor: null }) };
    const check = await recheckGroup(rpc, approved, home, new Set(), cutoff);
    const allowed = mode === 'desktop-empty';
    assert.equal(plan.groups.length === 1, allowed);
    assert.equal(check.allowed, allowed);
  });
});

test('retention below seven days is rejected', async () => {
  await assert.rejects(run({ days: 6 }), /Retention must be at least 7 days/);
});

// A stand-in app-server that answers like Codex but never removes the rollout on thread/delete.
const leakyServer = `
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const thread = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'fake-thread.json'), 'utf8'));
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  const result = method === 'thread/read' ? { thread }
    : method === 'thread/list' ? { data: params.archived || params.ancestorThreadId ? [] : [thread], nextCursor: null }
    : {};
  process.stdout.write(JSON.stringify({ id, result }) + '\\n');
});
`;

const rpcServer = leakyServer.replace('const result =', `
  if (method === 'pending') return;
  const result =`);

test('RPC exit rejects pending and future requests with the first error without new timers', { timeout: 10000 }, async t => {
  const home = fixture(), entry = path.join(home, 'rpc-app-server.mjs');
  fs.writeFileSync(path.join(home, 'fake-thread.json'), JSON.stringify(thread(home)));
  fs.writeFileSync(entry, rpcServer);
  const rpc = new Rpc(entry, home); t.after(() => rpc.close());
  await rpc.initialize();
  const pending = Promise.allSettled([rpc.request('pending'), rpc.request('pending')]);
  await rpc.request('ready'); // Ensure both pending requests reached the server before killing it.
  rpc.proc.kill();
  const results = await pending, failure = rpc.terminalError;
  assert.match(failure.message, /Codex server (exited|output closed)/);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason === failure));
  assert.equal(rpc.pending.size, 0);
  const timer = t.mock.method(globalThis, 'setTimeout', () => { throw new Error('must not start another RPC timer'); });
  const write = t.mock.method(rpc.proc.stdin, 'write', () => { throw new Error('must not write after exit'); });
  await assert.rejects(rpc.request('after-exit'), error => error === failure);
  assert.equal(timer.mock.callCount(), 0); assert.equal(write.mock.callCount(), 0);
  rpc.close(); assert.equal(rpc.terminalError, failure);
});

test('RPC send errors use the same terminal state and keep the original cause', { timeout: 10000 }, async t => {
  const home = fixture(), entry = path.join(home, 'rpc-app-server.mjs');
  fs.writeFileSync(path.join(home, 'fake-thread.json'), JSON.stringify(thread(home)));
  fs.writeFileSync(entry, leakyServer);
  const rpc = new Rpc(entry, home); t.after(() => rpc.close());
  await rpc.initialize();
  const failure = new Error('synthetic stdin failure');
  t.mock.method(rpc.proc.stdin, 'write', (data, callback) => { queueMicrotask(() => callback(failure)); return false; });
  await assert.rejects(rpc.request('send-failure'), error => error === failure);
  rpc.proc.stdin.emit('error', new Error('later stream error'));
  rpc.proc.emit('error', new Error('later process error'));
  await assert.rejects(rpc.request('after-failure'), error => error === failure);
  assert.equal(rpc.pending.size, 0); assert.equal(rpc.terminalError, failure);
});

test('RPC output EOF rejects requests even while the server and stdin remain alive', { timeout: 10000 }, async t => {
  const home = fixture(), entry = path.join(home, 'rpc-app-server.mjs');
  fs.writeFileSync(path.join(home, 'fake-thread.json'), JSON.stringify(thread(home)));
  fs.writeFileSync(entry, rpcServer);
  const rpc = new Rpc(entry, home); t.after(() => rpc.close());
  await rpc.initialize();
  const pending = Promise.allSettled([rpc.request('pending'), rpc.request('pending')]);
  await rpc.request('ready');
  // Inject EOF at the response transport boundary without Node's special stdio shutdown behavior.
  rpc.proc.stdout.push(null);
  const results = await pending;
  const failure = rpc.terminalError;
  assert.match(failure.message, /Codex server output closed/);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason === failure));
  assert.equal(rpc.proc.exitCode, null); assert.equal(rpc.proc.stdin.destroyed, false);
  assert.equal(rpc.pending.size, 0);
  await assert.rejects(rpc.request('after-eof'), error => error === failure);
});

for (const mode of ['error', 'close-only']) {
  test(`RPC output ${mode} uses the terminal state without an uncaught readline error`, { timeout: 10000 }, async t => {
    const home = fixture(), entry = path.join(home, 'rpc-app-server.mjs');
    fs.writeFileSync(path.join(home, 'fake-thread.json'), JSON.stringify(thread(home)));
    fs.writeFileSync(entry, rpcServer);
    const rpc = new Rpc(entry, home); t.after(() => rpc.close());
    await rpc.initialize();
    const pending = rpc.request('pending');
    const rejected = assert.rejects(pending, error => error === rpc.terminalError);
    await rpc.request('ready');
    const failure = mode === 'error' ? new Error('synthetic output read failure') : undefined;
    rpc.proc.stdout.destroy(failure);
    await rejected;
    assert.equal(rpc.proc.exitCode, null); assert.equal(rpc.pending.size, 0);
    if (failure) assert.equal(rpc.terminalError, failure);
    else assert.match(rpc.terminalError.message, /Codex server output closed/);
    const original = rpc.terminalError;
    rpc.proc.stdout.emit('error', new Error('later output error'));
    await assert.rejects(rpc.request('after-output-failure'), error => error === original);
  });
}

test('a compressed rollout left behind by a successful delete call is reported as a failure', async () => {
  const home = fixture(), t = thread(home);
  compress(t);
  const entry = path.join(home, 'leaky-app-server.mjs'); fs.writeFileSync(entry, leakyServer);
  fs.writeFileSync(path.join(home, 'fake-thread.json'), JSON.stringify(t));
  const protect = path.join(home, 'protect.json'); fs.writeFileSync(protect, '[]');
  await assert.rejects(run({ home, protectFile: protect, apply: true, entry, output: 'quiet' }), e => {
    const report = e.report;
    assert.deepEqual(report, JSON.parse(fs.readFileSync(report.reportPath, 'utf8')));
    assert.deepEqual(report.deleted, []);
    assert.deepEqual(report.failed, [{ rootId: t.id, error: 'Deletion API returned but rollout files remain' }]);
    return true;
  });
});

// Exercise the complete run -> manual -> catalog path with an isolated state DB.
const partialFailureServer = `
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
const home = process.env.CODEX_HOME;
const { threads, scenario } = JSON.parse(fs.readFileSync(path.join(home, 'fake-threads.json'), 'utf8'));
const deleted = new Set();
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  fs.appendFileSync(path.join(home, 'fake-requests.jsonl'), JSON.stringify({ method, params }) + '\\n');
  let result = {}, error;
  if (method === 'thread/list') {
    if (scenario === 'server-exit' && params.ancestorThreadId === threads[1].id) process.exit(23);
    if (!params.ancestorThreadId && deleted.size && scenario === 'final-list') {
      error = { code: -32000, message: 'synthetic final list failure' };
    } else result = { data: params.archived || params.ancestorThreadId ? [] : threads.filter(t => !deleted.has(t.id)), nextCursor: null };
  } else if (method === 'thread/read') result = { thread: threads.find(t => t.id === params.threadId) };
  else if (method === 'thread/delete') {
    if (scenario === 'delete' && params.threadId === threads[1].id) error = { code: -32000, message: 'synthetic deletion failure' };
    else {
      const t = threads.find(t => t.id === params.threadId);
      fs.unlinkSync(t.path);
      const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
      db.prepare('DELETE FROM threads WHERE id = ?').run(t.id); db.close();
      deleted.add(t.id);
      if (scenario === 'delete-then-exit' && params.threadId === threads[1].id) process.exit(24);
    }
  }
  process.stdout.write(JSON.stringify(error ? { id, error } : { id, result }) + '\\n');
});
`;

for (const scenario of ['delete', 'final-list', 'server-exit', 'delete-then-exit']) {
  test(`manual repairs verified successes and still fails after ${scenario} failure`, { timeout: 10000 }, async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const connectionLost = scenario.endsWith('exit');
    const home = fixture(), threads = Array.from({ length: connectionLost ? 3 : 2 }, () => thread(home));
    const entry = path.join(home, 'partial-app-server.mjs');
    fs.writeFileSync(entry, partialFailureServer);
    fs.writeFileSync(path.join(home, 'fake-threads.json'), JSON.stringify({ threads, scenario }));
    fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'pinned-thread-ids': [] }));
    const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)');
    for (const t of threads) state.prepare('INSERT INTO threads VALUES (?)').run(t.id);
    state.close();
    fs.mkdirSync(path.join(home, 'sqlite'));
    const catalog = new DatabaseSync(path.join(home, 'sqlite', 'codex.db'));
    catalog.exec(`
      CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, PRIMARY KEY(host_id, thread_id));
      CREATE TABLE local_thread_catalog_metadata (id INTEGER PRIMARY KEY, catalog_revision INTEGER);
      INSERT INTO local_thread_catalog_metadata VALUES (1, 0);
      CREATE TABLE local_thread_catalog_sync_state (host_id TEXT PRIMARY KEY, observation_sequence INTEGER);
      INSERT INTO local_thread_catalog_sync_state VALUES ('local', 0);
      CREATE TABLE local_thread_catalog_scan_checkpoints (host_id TEXT PRIMARY KEY);
      CREATE TABLE local_thread_catalog_scan_entries (host_id TEXT, thread_id TEXT, removed INTEGER, PRIMARY KEY(host_id, thread_id));
    `);
    for (const t of threads) catalog.prepare("INSERT INTO local_thread_catalog VALUES ('local', ?)").run(t.id);
    catalog.close();
    const expectedDeleted = scenario === 'final-list' ? 2 : 1;
    await assert.rejects(manual({ protectionFile: path.join(home, 'protected.json'), backupDir: path.join(home, 'backups'),
      checkClosed: async () => {}, ask: async () => `DELETE ${threads.length}`, log: () => {},
      runCleanup: options => run({ home, entry, ...options, output: 'quiet' }),
    }), error => {
      const report = error.report;
      assert.match(error.message, connectionLost ? /Codex server (exited|output closed)/ : scenario === 'delete' ? /Some deletions failed/ : /synthetic final list failure/);
      assert.equal(report.deleted.length, expectedDeleted);
      assert.equal(report.failed.length, scenario === 'final-list' ? 0 : 1);
      if (connectionLost) assert.deepEqual(report.skipped, [{ rootId: threads[2].id, reason: 'Codex 서버 연결 종료로 미처리' }]);
      assert.equal(report.catalogCleanup.removedRows, expectedDeleted);
      const saved = JSON.parse(fs.readFileSync(report.reportPath, 'utf8'));
      assert.equal(saved.error, error.message);
      assert.equal(saved.catalogCleanup.removedRows, expectedDeleted);
      assert(fs.readFileSync(report.textReportPath, 'utf8').includes(error.message));
      return true;
    });
    const remaining = new DatabaseSync(path.join(home, 'sqlite', 'codex.db'), { readOnly: true });
    try {
      assert.deepEqual(remaining.prepare('SELECT thread_id FROM local_thread_catalog').all().map(r => r.thread_id).sort(),
        scenario === 'final-list' ? [] : threads.slice(1).map(t => t.id).sort());
    } finally { remaining.close(); }
    assert.equal(fs.existsSync(threads[0].path), false);
    assert.equal(fs.existsSync(threads[1].path), scenario === 'delete' || scenario === 'server-exit');
    if (connectionLost) {
      assert.ok(fs.existsSync(threads[2].path));
      const requests = fs.readFileSync(path.join(home, 'fake-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      // Preview and apply each list active/archived once; no final RPC listing follows exit.
      assert.equal(requests.filter(r => r.method === 'thread/list' && !r.params.ancestorThreadId).length, 4);
      assert.ok(!requests.some(r => r.params.ancestorThreadId === threads[2].id || r.params.threadId === threads[2].id));
      assert.deepEqual(requests.filter(r => r.method === 'thread/delete').map(r => r.params.threadId),
        threads.slice(0, scenario === 'delete-then-exit' ? 2 : 1).map(t => t.id));
    }
  });
}

test('official deletion API removes only eligible synthetic logs and their metadata', { timeout: 180000 }, async () => {
  const home = fixture();
  const oldRoot = thread(home), child = thread(home, { parent: oldRoot.id });
  const oldArchived = thread(home, { archived: true });
  const missingRollout = thread(home), compressed = thread(home);
  const pinned = thread(home), newer = thread(home, { updatedAt: recent });
  const held = thread(home), familyRoot = thread(home), familyChild = thread(home, { parent: familyRoot.id, updatedAt: recent });
  const retained = [pinned, newer, held, familyRoot, familyChild];
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'pinned-thread-ids': [pinned.id] }));
  const protect = path.join(home, 'protect.json'); fs.writeFileSync(protect, JSON.stringify([held.id]));
  const rpc = new Rpc(locateCodex(), home);
  try {
    await rpc.initialize();
    // Import these hand-written test rollouts into this isolated test database.
    const all = await listAll(rpc, true, { useStateDbOnly: false });
    assert.equal(all.length, 10);
    const childRecord = all.find(t => t.id === child.id);
    assert.equal(childRecord.parentThreadId || childRecord.source?.subAgent?.thread_spawn?.parent_thread_id
      || childRecord.source?.subagent?.thread_spawn?.parent_thread_id, oldRoot.id, JSON.stringify(childRecord));
    assert((await readPins(home)).has(pinned.id));
  } finally { rpc.close(); }
  // Only the disposable fixture file is removed; production files are untouched.
  fs.unlinkSync(missingRollout.path);
  const staleRpc = new Rpc(locateCodex(), home);
  try {
    await staleRpc.initialize();
    const staleGroup = planCleanup([missingRollout], new Set(), new Set(), cutoff, home).groups[0];
    assert.equal((await recheckGroup(staleRpc, staleGroup, home, new Set(), cutoff)).allowed, true);
    await staleRpc.request('thread/delete', { threadId: missingRollout.id });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT id FROM threads WHERE id = ?').get(missingRollout.id), undefined); }
    finally { db.close(); }
  } finally { staleRpc.close(); }
  compress(compressed);
  const before = fs.readFileSync(oldRoot.path);
  const preview = await run({ home, protectFile: protect });
  assert.equal(preview.days, 7);
  assert.equal(preview.candidateSessions, 4);
  assert(preview.candidates.find(g => g.rootId === compressed.id).bytes > 0);
  assert.deepEqual(fs.readFileSync(oldRoot.path), before);
  const result = await run({ home, protectFile: protect, apply: true });
  assert.equal(result.deleted.reduce((n,g) => n + g.ids.length, 0), 4);
  for (const t of [oldRoot, child, oldArchived]) assert.equal(fs.existsSync(t.path), false);
  assert.equal(fs.existsSync(compressed.path + '.zst'), false);
  for (const t of retained) assert.equal(fs.existsSync(t.path), true);
});
