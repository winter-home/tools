import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { repairCatalog, readDeletionReports } from './catalog.mjs';
import { repairList } from './repair-list.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-test-'));
  for (const dir of ['sessions', 'archived_sessions', 'sqlite', 'reports']) fs.mkdirSync(path.join(home, dir));
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)'); state.close();
  const report = { home, mode: 'apply', deleted: [], candidates: [], failed: [] };
  return { home, report, reports: [report], backupDir: path.join(home, 'reports', 'backups'), checkClosed: async () => {} };
}

function deleted(f, { restored = false, compressed = false, failed = false } = {}) {
  const id = randomUUID(), file = path.join(f.home, 'sessions', `rollout-${id}.jsonl`);
  f.report.deleted.push({ rootId: id, ids: [id], bytes: 0 });
  f.report.candidates.push({ rootId: id, ids: [id], files: [{ id, file }] });
  if (restored) {
    const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
    db.prepare('INSERT INTO threads VALUES (?)').run(id); db.close();
  }
  if (compressed) fs.writeFileSync(file + '.zst', 'compressed rollout');
  if (failed) f.report.failed.push({ rootId: id, error: 'Metadata still present after deletion' });
  return id;
}

function catalog(f, ids, name = 'codex.db') {
  const file = path.join(f.home, 'sqlite', name), db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, missing_candidate INTEGER DEFAULT 0,
      PRIMARY KEY(host_id, thread_id));
    CREATE TABLE local_thread_catalog_metadata (id INTEGER PRIMARY KEY, catalog_revision INTEGER);
    INSERT INTO local_thread_catalog_metadata VALUES (1, 10);
    CREATE TABLE local_thread_catalog_sync_state (host_id TEXT PRIMARY KEY, observation_sequence INTEGER);
    INSERT INTO local_thread_catalog_sync_state VALUES ('local', 20);
    CREATE TABLE local_thread_catalog_scan_checkpoints (host_id TEXT PRIMARY KEY, checkpoint TEXT);
    CREATE TABLE local_thread_catalog_scan_entries (host_id TEXT, thread_id TEXT, removed INTEGER,
      PRIMARY KEY(host_id, thread_id));
    CREATE TABLE automations (id TEXT);
    INSERT INTO automations VALUES ('keep');
  `);
  const add = db.prepare('INSERT INTO local_thread_catalog (host_id, thread_id) VALUES (?, ?)');
  for (const id of ids) { add.run('local', id); add.run('remote', id); }
  db.close(); return file;
}

function read(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); }
}

test('preview and repair target only verified deleted local entries and back up both catalogs', async () => {
  const f = fixture(), gone = deleted(f), restored = deleted(f, { restored: true }),
    compressed = deleted(f, { compressed: true }), failed = deleted(f, { failed: true }), unknown = randomUUID();
  const ids = [gone, restored, compressed, failed, unknown];
  const files = ['codex.db', 'codex-dev.db'].map(name => catalog(f, ids, name));
  const writer = new DatabaseSync(files[0]);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO local_thread_catalog_scan_checkpoints VALUES ('local', 'resume');");
  try {
    const preview = await repairCatalog(f);
    assert.equal(preview.entryCount, 2);
    assert.equal(fs.existsSync(f.backupDir), false);
    assert.equal(read(files[0], 'SELECT * FROM local_thread_catalog').length, 10);
    const result = await repairCatalog({ ...f, apply: true });
    assert.equal(result.removedRows, 2);
    for (const item of result.databases) {
      assert.equal(read(item.backupPath, 'SELECT * FROM local_thread_catalog').length, 10);
      assert.equal(read(item.file, 'SELECT * FROM local_thread_catalog').length, 9);
      assert.deepEqual(read(item.file, "SELECT thread_id FROM local_thread_catalog WHERE host_id='local'").map(r => r.thread_id).sort(),
        [restored, compressed, failed, unknown].sort());
      assert.equal(read(item.file, 'SELECT catalog_revision FROM local_thread_catalog_metadata')[0].catalog_revision, 11);
      assert.equal(read(item.file, "SELECT observation_sequence FROM local_thread_catalog_sync_state WHERE host_id='local'")[0].observation_sequence, 21);
      assert.deepEqual(read(item.file, 'SELECT * FROM automations'), [{ id: 'keep' }]);
    }
    assert.deepEqual(read(result.databases[0].backupPath, 'SELECT checkpoint FROM local_thread_catalog_scan_checkpoints'), [{ checkpoint: 'resume' }]);
    assert.deepEqual(read(files[0], 'SELECT * FROM local_thread_catalog_scan_entries'), [{ host_id: 'local', thread_id: gone, removed: 1 }]);
    assert.deepEqual(read(files[1], 'SELECT * FROM local_thread_catalog_scan_entries'), []);
    assert.equal((await repairCatalog({ ...f, apply: true })).removedRows, 0);
  } finally { writer.close(); }
});

test('a late database error rolls back removals and revision changes, retaining the backup', async () => {
  const f = fixture(), first = deleted(f), second = deleted(f), file = catalog(f, [first, second]);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TRIGGER refuse_removal BEFORE DELETE ON local_thread_catalog
    WHEN OLD.thread_id = '${[first, second].sort()[1]}' BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
  db.close();
  await assert.rejects(repairCatalog({ ...f, apply: true }), /blocked/);
  assert.equal(read(file, 'SELECT * FROM local_thread_catalog').length, 4);
  assert.equal(read(file, 'SELECT catalog_revision FROM local_thread_catalog_metadata')[0].catalog_revision, 10);
  assert.equal(read(file, "SELECT observation_sequence FROM local_thread_catalog_sync_state WHERE host_id='local'")[0].observation_sequence, 20);
  const audit = JSON.parse(fs.readFileSync(path.join(f.backupDir, fs.readdirSync(f.backupDir)[0], 'result.json'), 'utf8'));
  assert.equal(audit.error, 'blocked');
  assert.equal(read(audit.databases[0].backupPath, 'SELECT * FROM local_thread_catalog').length, 4);
});

test('an open Codex blocks repair before any database or backup is changed', async () => {
  const f = fixture(), gone = deleted(f), file = catalog(f, [gone]);
  await assert.rejects(repairCatalog({ ...f, apply: true,
    checkClosed: async () => { throw new Error('still running'); } }), /still running/);
  assert.equal(read(file, 'SELECT * FROM local_thread_catalog').length, 2);
  assert.equal(fs.existsSync(f.backupDir), false);
});

test('restored sessions and entries outside the approved preview remain untouched', async () => {
  const f = fixture(), restored = deleted(f), unapproved = deleted(f), file = catalog(f, [restored, unapproved]);
  let checks = 0;
  const result = await repairCatalog({ ...f, apply: true, approvedIds: [restored], checkClosed: async () => {
    if (++checks === 3) {
      const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
      db.prepare('INSERT INTO threads VALUES (?)').run(restored); db.close();
    }
  } });
  assert.equal(result.removedRows, 0);
  assert.equal(read(file, 'SELECT * FROM local_thread_catalog').length, 4);
});

test('foreign-home reports, unrecorded deletions, and invalid paths cannot remove entries', async () => {
  const f = fixture(), gone = deleted(f), file = catalog(f, [gone]);
  f.report.home = path.join(f.home, 'other');
  assert.equal((await repairCatalog(f)).entryCount, 0);
  f.report.home = f.home; f.report.mode = 'preview';
  assert.equal((await repairCatalog(f)).entryCount, 0);
  f.report.mode = 'apply'; f.report.candidates = [];
  assert.equal((await repairCatalog(f)).entryCount, 0);
  f.report.candidates = [{ rootId: gone, ids: [gone], files: [{ id: gone, file: path.join(f.home, `outside-${gone}.jsonl`) }] }];
  await assert.rejects(repairCatalog({ ...f, apply: true }), /Unexpected rollout path/);
  assert.equal(read(file, 'SELECT * FROM local_thread_catalog').length, 2);
});

test('an incompatible catalog schema stops repair without mutating it', async () => {
  const f = fixture(), gone = deleted(f), file = catalog(f, [gone]);
  const db = new DatabaseSync(file); db.exec('DROP TABLE local_thread_catalog_metadata'); db.close();
  await assert.rejects(repairCatalog({ ...f, apply: true }), /local_thread_catalog_metadata/);
  assert.equal(read(file, 'SELECT * FROM local_thread_catalog').length, 2);
  assert.equal(fs.existsSync(f.backupDir), false);
});

test('repair-list previews without requiring a closed app and Enter cancels the repair', async () => {
  const f = fixture(), gone = deleted(f), file = catalog(f, [gone]);
  const reportsDir = path.join(f.home, 'reports');
  fs.writeFileSync(path.join(reportsDir, 'old-apply.json'), JSON.stringify(f.report));
  fs.writeFileSync(path.join(reportsDir, 'fixture-apply.json'), JSON.stringify({ ...f.report, home: f.home + '-other' }));
  assert.equal(readDeletionReports(f.home, reportsDir).reports.length, 1);
  const preview = await repairList({ home: f.home, reportsDir, previewOnly: true, log: () => {},
    checkClosed: async () => { throw new Error('should not check'); } });
  assert.equal(preview.entryCount, 1);
  const cancelled = await repairList({ home: f.home, reportsDir, checkClosed: f.checkClosed,
    ask: async () => '', log: () => {} });
  assert.equal(cancelled.cancelled, true);
  assert.equal(read(file, 'SELECT * FROM local_thread_catalog').length, 2);
  const result = await repairList({ home: f.home, reportsDir, checkClosed: f.checkClosed,
    ask: async () => 'CLEAN 1', log: () => {} });
  assert.equal(result.removedRows, 1);
});

test('damaged and unreadable reports are identified while valid reports still repair their entries', async () => {
  const f = fixture(), gone = deleted(f), file = catalog(f, [gone]);
  const reportsDir = path.join(f.home, 'reports');
  fs.writeFileSync(path.join(reportsDir, 'good-apply.json'), JSON.stringify(f.report));
  const badFiles = ['truncated-apply.json', 'invalid-apply.json', 'unreadable-apply.json'];
  fs.writeFileSync(path.join(reportsDir, badFiles[0]), '{');
  fs.writeFileSync(path.join(reportsDir, badFiles[1]), JSON.stringify({ ...f.report, deleted: 'invalid' }));
  fs.mkdirSync(path.join(reportsDir, badFiles[2]));
  const loaded = readDeletionReports(f.home, reportsDir);
  assert.equal(loaded.reports.length, 1);
  assert.deepEqual(loaded.skippedReports.map(item => path.basename(item.file)).sort(), badFiles.sort());
  assert(loaded.skippedReports.every(item => path.isAbsolute(item.file) && item.error.length));
  const messages = [];
  const result = await repairList({ home: f.home, reportsDir, checkClosed: f.checkClosed,
    ask: async () => 'CLEAN 1', log: text => messages.push(text) });
  assert.equal(result.removedRows, 1);
  assert.equal(result.skippedReports.length, 3);
  for (const name of badFiles) assert(messages.some(text => text.includes(path.join(reportsDir, name)) && text.includes('사유:')));
  assert.match(messages.at(-1), /보고서 3개를 건너뛰었습니다/);
  assert.deepEqual(read(file, 'SELECT host_id FROM local_thread_catalog'), [{ host_id: 'remote' }]);
});

test('an entirely damaged report set warns and never asks to apply or creates backups', async () => {
  const f = fixture(), gone = deleted(f), file = catalog(f, [gone]);
  const reportsDir = path.join(f.home, 'reports'), messages = [];
  fs.writeFileSync(path.join(reportsDir, 'broken-apply.json'), '');
  const result = await repairList({ home: f.home, reportsDir, checkClosed: f.checkClosed,
    ask: async () => { assert.fail('nothing may be applied without a valid report'); },
    log: text => messages.push(text) });
  assert.equal(result.entryCount, 0);
  assert.equal(result.skippedReports.length, 1);
  assert.match(messages.at(-1), /보고서 1개를 건너뛰었습니다/);
  assert.equal(read(file, 'SELECT * FROM local_thread_catalog').length, 2);
  assert.equal(fs.existsSync(path.join(reportsDir, 'catalog-backups')), false);
});

test('invalid report IDs and paths are isolated before filesystem checks so valid reports still repair', async () => {
  const f = fixture(), gone = deleted(f), file = catalog(f, [gone]);
  const reportsDir = path.join(f.home, 'reports');
  const source = path.join(reportsDir, 'good-apply.json');
  fs.writeFileSync(source, JSON.stringify({ ...f.report, reportPath: 'obsolete-location.json' }));
  const badFiles = [];
  for (const [name, id, rollout] of [
    ['uuid', 'not-a-uuid', path.join(f.home, 'sessions', 'rollout-not-a-uuid.jsonl')],
    ['outside', gone, path.join(f.home, `rollout-${gone}.jsonl`)],
    ['extension', gone, path.join(f.home, 'sessions', `rollout-${gone}.txt`)],
    ['filename', gone, path.join(f.home, 'sessions', 'rollout-other.jsonl')],
  ]) {
    const invalid = { ...f.report,
      deleted: [{ rootId: id, ids: [id] }],
      candidates: [{ rootId: id, ids: [id], files: [{ id, file: rollout }] }] };
    const badFile = path.join(reportsDir, `${name}-apply.json`);
    fs.writeFileSync(badFile, JSON.stringify(invalid)); badFiles.push(badFile);
  }
  const loaded = readDeletionReports(f.home, reportsDir);
  assert.equal(loaded.reports.length, 1);
  assert.equal(loaded.reports[0].reportPath, source);
  assert.deepEqual(loaded.skippedReports.map(item => item.file).sort(), badFiles.sort());
  const messages = [];
  const result = await repairList({ home: f.home, reportsDir, checkClosed: f.checkClosed,
    ask: async () => 'CLEAN 1', log: text => messages.push(text) });
  assert.equal(result.removedRows, 1);
  assert.equal(result.skippedReports.length, 4);
  for (const badFile of badFiles) assert(messages.some(text => text.includes(badFile)));
  assert.deepEqual(read(file, 'SELECT host_id FROM local_thread_catalog'), [{ host_id: 'remote' }]);
});

test('current filesystem validation errors remain fatal and identify the source report', async () => {
  const f = fixture(), gone = deleted(f), file = catalog(f, [gone]);
  const reportsDir = path.join(f.home, 'reports'), source = path.join(reportsDir, 'current-apply.json');
  fs.writeFileSync(source, JSON.stringify({ ...f.report, reportPath: 'obsolete-location.json' }));
  fs.mkdirSync(f.report.candidates[0].files[0].file);
  assert.equal(readDeletionReports(f.home, reportsDir).skippedReports.length, 0);
  await assert.rejects(repairList({ home: f.home, reportsDir, previewOnly: true, log: () => {} }), error => {
    assert(error.message.includes(source));
    assert.match(error.message, /Not a regular rollout/);
    assert.match(error.cause.message, /Not a regular rollout/);
    return true;
  });
  assert.equal(read(file, 'SELECT * FROM local_thread_catalog').length, 2);
  assert.equal(fs.existsSync(path.join(reportsDir, 'catalog-backups')), false);
});
