import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { planCleanup, listAll, readPins, recheckGroup, Rpc, locateCodex, run } from './cleanup.mjs';

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
  const eligible = thread(home);
  const entries = [eligible, thread(home, { updatedAt: recent }), thread(home, { pinned: true }),
    thread(home, { status: 'active' }), thread(home, { modified: recent }), thread(home, { updatedAt: cutoff })];
  const explicit = thread(home); entries.push(explicit);
  const p = planCleanup(entries, new Set(), new Set([explicit.id]), cutoff, home);
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

test('retention below seven days is rejected', async () => {
  await assert.rejects(run({ days: 6 }), /Retention must be at least 7 days/);
});

test('official deletion API removes only eligible synthetic logs and their metadata', { timeout: 180000 }, async () => {
  const home = fixture();
  const oldRoot = thread(home), child = thread(home, { parent: oldRoot.id });
  const oldArchived = thread(home, { archived: true });
  const missingRollout = thread(home);
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
    assert.equal(all.length, 9);
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
  const before = fs.readFileSync(oldRoot.path);
  const preview = await run({ home, protectFile: protect });
  assert.equal(preview.days, 7);
  assert.equal(preview.candidateSessions, 3);
  assert.deepEqual(fs.readFileSync(oldRoot.path), before);
  const result = await run({ home, protectFile: protect, apply: true });
  assert.equal(result.deleted.reduce((n,g) => n + g.ids.length, 0), 3);
  for (const t of [oldRoot, child, oldArchived]) assert.equal(fs.existsSync(t.path), false);
  for (const t of retained) assert.equal(fs.existsSync(t.path), true);
});
