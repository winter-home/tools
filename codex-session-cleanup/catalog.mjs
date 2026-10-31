import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileInfo, resolveRolloutPath } from './cleanup.mjs';
import { ensureCodexClosed } from './processes.mjs';
import { loadSqlite } from './runtime.mjs';

const samePath = (a, b) => path.relative(path.toNamespacedPath(path.resolve(a)),
  path.toNamespacedPath(path.resolve(b))) === '';

export function readDeletionReports(home, directory) {
  const result = { reports: [], skippedReports: [] };
  if (!fs.existsSync(directory)) return result;
  for (const name of fs.readdirSync(directory).filter(n => n.endsWith('-apply.json'))) {
    const file = path.resolve(directory, name);
    try {
      const report = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('보고서가 JSON 객체가 아닙니다.');
      if (report.mode !== 'apply') continue;
      if (typeof report.home !== 'string') throw new Error('보고서의 home이 올바르지 않습니다.');
      if (!samePath(report.home, home)) continue;
      const groupValid = g => g && typeof g.rootId === 'string' && Array.isArray(g.ids)
        && g.ids.every(id => typeof id === 'string');
      if (!Array.isArray(report.deleted) || !report.deleted.every(groupValid)
        || (report.failed !== undefined && (!Array.isArray(report.failed)
          || !report.failed.every(g => g && typeof g.rootId === 'string')))
        || (report.deleted.length && !Array.isArray(report.candidates))
        || (report.candidates !== undefined && (!Array.isArray(report.candidates) || !report.candidates.every(g =>
          groupValid(g) && Array.isArray(g.files)
          && g.files.every(f => f && typeof f.id === 'string' && typeof f.file === 'string'))))) {
        throw new Error('보고서의 삭제 결과 또는 대상 목록 형식이 올바르지 않습니다.');
      }
      for (const group of report.candidates || []) {
        for (const item of group.files) resolveRolloutPath({ id: item.id, path: item.file }, home);
      }
      result.reports.push({ ...report, reportPath: file });
    } catch (error) { result.skippedReports.push({ file, error: error.message }); }
  }
  return result;
}

// Missing files alone are insufficient: require a recorded successful deletion,
// its validated rollout path, and absence from the current authoritative state DB.
function verifiedDeletions(home, reports, DatabaseSync) {
  const files = new Map();
  for (const report of reports) {
    if (report.mode !== 'apply' || typeof report.home !== 'string' || !samePath(report.home, home)) continue;
    const candidates = new Map((report.candidates || []).map(g => [g.rootId, g]));
    for (const group of report.deleted || []) {
      if (report.failed?.some(g => g.rootId === group.rootId)) continue;
      const original = candidates.get(group.rootId);
      if (!original || original.ids.length !== group.ids.length || group.ids.some(id => !original.ids.includes(id))) continue;
      for (const id of group.ids) {
        const recorded = original.files.find(f => f.id === id);
        if (!recorded) continue;
        let info;
        try { info = fileInfo({ id, path: recorded.file }, home); }
        catch (cause) {
          throw new Error(`보고서 ${report.reportPath || '(직접 전달된 보고서)'}의 현재 로그 상태를 확인하지 못했습니다: ${cause.message}`, { cause });
        }
        if (!info.exists) files.set(id, info.file);
      }
    }
  }
  if (!files.size) return files;
  const name = fs.readdirSync(home).filter(n => /^state_\d+\.sqlite$/.test(n))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  if (!name) throw new Error('Cannot verify deleted sessions: current state DB is missing');
  const db = new DatabaseSync(path.join(home, name), { readOnly: true });
  try {
    const lookup = db.prepare('SELECT 1 FROM threads WHERE id = ?');
    for (const id of files.keys()) if (lookup.get(id)) files.delete(id);
  } finally { db.close(); }
  return files;
}

function catalogIds(db, verified) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_thread_catalog'").get()) return [];
  // Fail before writing if this app version has an incompatible catalog schema.
  db.prepare('SELECT catalog_revision FROM local_thread_catalog_metadata WHERE id = 1');
  db.prepare('SELECT observation_sequence FROM local_thread_catalog_sync_state WHERE host_id = ?');
  db.prepare('SELECT 1 FROM local_thread_catalog_scan_checkpoints WHERE host_id = ?');
  db.prepare('SELECT removed FROM local_thread_catalog_scan_entries WHERE host_id = ? AND thread_id = ?');
  return db.prepare("SELECT thread_id FROM local_thread_catalog WHERE host_id = 'local'").all()
    .map(r => r.thread_id).filter(id => verified.has(id));
}

export async function repairCatalog({ home, reports, apply = false, approvedIds,
  backupDir, checkClosed = ensureCodexClosed }) {
  const { DatabaseSync, backup } = await loadSqlite();
  home = path.resolve(home);
  if (apply) await checkClosed();
  const verified = verifiedDeletions(home, reports, DatabaseSync);
  if (approvedIds) for (const id of verified.keys()) if (!approvedIds.includes(id)) verified.delete(id);
  const result = { mode: apply ? 'apply' : 'preview', home, databases: [], entryCount: 0, removedRows: 0 };
  for (const name of ['codex.db', 'codex-dev.db']) {
    const file = path.join(home, 'sqlite', name);
    if (!verified.size || !fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const ids = catalogIds(db, verified);
      if (ids.length) result.databases.push({ file, ids });
      result.entryCount += ids.length;
    } finally { db.close(); }
  }
  if (!apply || !result.entryCount) return result;
  if (!backupDir) throw new Error('A backup directory is required for catalog repair');
  result.backupDirectory = path.join(backupDir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
  fs.mkdirSync(result.backupDirectory, { recursive: true });
  const save = () => fs.writeFileSync(path.join(result.backupDirectory, 'result.json'), JSON.stringify(result, null, 2));
  save();
  try {
    for (const item of result.databases) {
      await checkClosed();
      const db = new DatabaseSync(item.file, { open: true });
      let transaction = false;
      try {
        item.backupPath = path.join(result.backupDirectory, path.basename(item.file));
        // SQLite's backup API includes committed WAL data; a raw file copy does not.
        await backup(db, item.backupPath);
        await checkClosed();
        const fresh = verifiedDeletions(home, reports, DatabaseSync);
        const ids = catalogIds(db, fresh).filter(id => item.ids.includes(id));
        db.exec('BEGIN IMMEDIATE'); transaction = true;
        if (!db.prepare('SELECT 1 FROM local_thread_catalog_metadata WHERE id = 1').get()
          || !db.prepare("SELECT 1 FROM local_thread_catalog_sync_state WHERE host_id = 'local'").get()) {
          throw new Error('Cannot verify local catalog revision or sync state');
        }
        const checkpoint = db.prepare("SELECT 1 FROM local_thread_catalog_scan_checkpoints WHERE host_id = 'local'").get();
        const remove = db.prepare("DELETE FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?");
        const tombstone = db.prepare(`INSERT INTO local_thread_catalog_scan_entries (host_id, thread_id, removed)
          VALUES ('local', ?, 1) ON CONFLICT(host_id, thread_id) DO UPDATE SET removed = 1`);
        let removed = 0;
        for (const id of ids) {
          if (checkpoint) tombstone.run(id);
          removed += remove.run(id).changes;
        }
        if (removed) {
          db.prepare("UPDATE local_thread_catalog_sync_state SET observation_sequence = observation_sequence + ? WHERE host_id = 'local'").run(removed);
          db.exec('UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1');
        }
        const remaining = db.prepare("SELECT 1 FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?");
        if (ids.some(id => remaining.get(id))) throw new Error('Catalog entries remain after repair');
        db.exec('COMMIT'); transaction = false;
        item.removedRows = removed; result.removedRows += removed;
      } finally {
        if (transaction) db.exec('ROLLBACK');
        db.close();
      }
      save();
    }
    return result;
  } catch (error) {
    result.error = error.message;
    throw new Error(`${error.message}\n목록 DB 백업 및 처리 기록: ${result.backupDirectory}`, { cause: error });
  } finally { save(); }
}
