import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { atomicJson, backupFiles, checked, exists, fileInventory, inventory, readJson, sameFiles, uuid } from './files.mjs';
import { deletionPolicy, desktopDirectories, readProtection, requireVerifiedPins } from './protection.mjs';
import { checkMetadata, indexesFor, prepareMetadata, projectsIn, remainingHistoryIds, updateMetadata } from './metadata.mjs';
import { ensureClaudeClosed } from './processes.mjs';
import { formatPreview, formatResult, formatTextReport } from './output.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultHome = () => path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));

class TranscriptFormatError extends Error {}

export function loadConfig(file = path.join(here, 'config.json')) {
  const config = readJson(file);
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('잘못된 정리 설정입니다.');
  if (!Number.isInteger(config.days) || config.days < 7) throw new Error('days는 7 이상의 정수여야 합니다.');
  if (!Array.isArray(config.protectedIds) || config.protectedIds.some(id => typeof id !== 'string' || !uuid.test(id))) {
    throw new Error('protectedIds에는 실제 대화 UUID만 지정할 수 있습니다.');
  }
  if (!Array.isArray(config.desktopDataDirs) || config.desktopDataDirs.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
    throw new Error('desktopDataDirs에는 Claude 앱 데이터 폴더의 절대 경로만 지정할 수 있습니다.');
  }
  if (config.removePromptHistory !== undefined && typeof config.removePromptHistory !== 'boolean') {
    throw new Error('removePromptHistory는 true 또는 false여야 합니다.');
  }
}

function directories(config, desktopDirs) {
  return [...new Set((desktopDirs ?? [...desktopDirectories(), ...config.desktopDataDirs]).map(p => path.resolve(p)))];
}

export function collectFiles(group, home) {
  return [...group.mains.flatMap(main => fileInventory(home, main, { required: true })),
    ...collectArtifacts(group, home)];
}

function collectArtifacts(group, home) {
  const files = [];
  for (const main of group.mains) {
    const folder = path.dirname(main);
    const basename = path.basename(main, '.jsonl');
    files.push(...inventory(home, path.join(folder, basename)));
    for (const name of exists(folder) ? fs.readdirSync(folder) : []) {
      if (name.startsWith(`${basename}.orphaned-`) && name.endsWith('.jsonl')
        || name.startsWith(`${basename}.jsonl.superseded-`)) files.push(...fileInventory(home, path.join(folder, name)));
    }
  }
  for (const folder of ['file-history', 'session-env']) files.push(...inventory(home, path.join(home, folder, group.id)));
  files.push(...fileInventory(home, path.join(home, 'debug', `${group.id}.txt`)));
  return [...new Map(files.map(f => [f.file, f])).values()].sort((a, b) => a.file.localeCompare(b.file));
}

async function transcriptInfo(file, id) {
  let modified = 0, messages = 0, desktop = false;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let streamError;
  input.on('error', error => { streamError = error; lines.close(); });
  try {
    for await (const raw of lines) {
      const line = raw.replace(/^\uFEFF/, '');
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new TranscriptFormatError(`로그의 JSON 형식이 올바르지 않습니다: ${file}`, { cause: error });
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TranscriptFormatError('JSON 객체가 아닙니다.');
      // Subagent transcripts use the parent's session ID too. Missing IDs are normal for snapshots.
      if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.toLowerCase() !== id)) {
        throw new TranscriptFormatError('파일명과 대화 ID가 다릅니다.');
      }
      desktop ||= /desktop|cowork/i.test(value.entrypoint || '');
      if (value.timestamp !== undefined) {
        const time = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
        if (!Number.isFinite(time)) throw new TranscriptFormatError('활동 시각이 올바르지 않습니다.');
        modified = Math.max(modified, time);
      }
      if (value.type === 'user' || value.type === 'assistant') messages++;
    }
  } finally { lines.close(); input.destroy(); }
  if (streamError) throw streamError;
  if (!messages || !modified) throw new TranscriptFormatError('대화와 활동 시각을 확인할 수 없습니다.');
  return { modified, desktop };
}

export async function preview({ home = defaultHome(), config = loadConfig(), desktopDirs, now = Date.now() } = {}) {
  home = path.resolve(home);
  // Validate injected configs exactly like the on-disk config, without writing a settings file.
  validateConfig(config);
  checked(home, home);
  const dirs = directories(config, desktopDirs), protection = readProtection(dirs);
  const root = path.join(home, 'projects'), groups = new Map(), projects = projectsIn(home);
  for (const project of projects) {
    const folder = path.join(root, project.name);
    for (const name of fs.readdirSync(folder)) {
      if (!name.endsWith('.jsonl') || !uuid.test(name.slice(0, -6))) continue;
      const main = path.join(folder, name);
      if (!checked(home, main).isFile()) continue;
      const id = name.slice(0, -6).toLowerCase();
      if (!groups.has(id)) groups.set(id, { id, mains: [], files: [], reasons: [] });
      groups.get(id).mains.push(main);
    }
  }
  indexesFor(projects); // Reject unreadable indexes before offering a deletion confirmation.
  const protectedIds = new Set(config.protectedIds.map(id => id.toLowerCase()));
  const cutoff = now - config.days * 86400000;
  for (const group of groups.values()) {
    if (protection.pins.has(group.id)) group.reasons.push('고정');
    if (protectedIds.has(group.id)) group.reasons.push('추가 보호');
    try {
      group.files = collectFiles(group, home);
      group.bytes = group.files.reduce((sum, f) => sum + f.size, 0);
      group.modified = group.files.reduce((latest, f) => Math.max(latest, f.mtimeMs), 0);
      for (const record of protection.records.filter(r => r.cliId === group.id)) {
        group.modified = Math.max(group.modified, record.modified, ...record.files.map(f => f.mtimeMs));
      }
      if (group.modified >= cutoff) group.reasons.push('최근 활동');
      if (group.files.some(f => f.file.split(path.sep).includes('mcp-tasks'))) group.reasons.push('MCP 작업 상태 보존');
      if (!group.reasons.length) {
        // Avoid parsing many gigabytes of recent logs. Only prospective deletions need full inspection.
        const transcripts = new Set([...group.mains, ...group.files
          .filter(f => f.file.endsWith('.jsonl') || path.basename(f.file).includes('.jsonl.superseded-')).map(f => f.file)]);
        for (const file of transcripts) {
          // Orphaned files can contain a partially-written transcript; retain the group if unreadable.
          const info = await transcriptInfo(file, group.id);
          group.modified = Math.max(group.modified, info.modified);
          if (info.desktop && protection.state === 'absent') group.reasons.push('앱 고정 상태 확인 불가');
        }
        if (group.modified >= cutoff) group.reasons.push('최근 대화');
        // Catch writes while streaming the transcript even during a read-only preview.
        if (!sameFiles(group.files, collectFiles(group, home))) group.reasons.push('확인 중 변경');
      }
    } catch (error) {
      // Content faults quarantine one session; filesystem and safety faults stop the entire scan.
      if (!(error instanceof TranscriptFormatError)) throw error;
      group.reasons.push(`검증 실패: ${error.message}`);
    }
    group.reasons = [...new Set(group.reasons)];
  }
  const all = [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  const candidates = all.filter(g => !g.reasons.length), excluded = all.filter(g => g.reasons.length);
  return { mode: 'preview', home, days: config.days, createdAt: new Date(now).toISOString(),
    removePromptHistory: config.removePromptHistory === true,
    pinState: protection.state, protectionWarnings: protection.warnings,
    deletionBlockedReasons: deletionPolicy(protection).reasons,
    desktopDirs: dirs, pinCount: protection.pins.size, totalSessions: all.length,
    candidateSessions: candidates.length, candidateBytes: candidates.reduce((sum, g) => sum + g.bytes, 0),
    candidates, excluded, projects };
}

export function writeReport(report, directory) {
  fs.mkdirSync(directory, { recursive: true });
  if (!report.reportPath) {
    const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${report.mode}-${randomUUID().slice(0, 8)}`;
    report.reportPath = path.join(directory, `${base}.json`);
    report.textReportPath = path.join(directory, `${base}.txt`);
  }
  // Excluded sessions need reasons, not a second full inventory in every report.
  atomicJson(report.reportPath, { ...report, excluded: report.excluded.map(({ files, ...group }) => group) });
  fs.writeFileSync(report.textReportPath, '\uFEFF' + formatTextReport(report), 'utf8');
}

export async function verifyDeletedSessions(home, groups, removePromptHistory) {
  const ids = new Set(groups.map(g => g.id)), projects = projectsIn(home);
  const remainingFiles = [];
  for (const group of groups) {
    const mains = new Set(group.mains);
    for (const project of projects) {
      const folder = path.join(home, 'projects', project.name);
      mains.add(path.join(folder, `${group.id}.jsonl`));
      for (const name of fs.readdirSync(folder)) {
        if (name.toLowerCase() === `${group.id}.jsonl`) mains.add(path.join(folder, name));
      }
    }
    // Verification asks whether a main path still exists, regardless of its current kind.
    for (const file of mains) if (exists(file)) {
      checked(home, file); remainingFiles.push({ id: group.id, file });
    }
    for (const file of collectArtifacts({ ...group, mains: [...mains] }, home)) {
      remainingFiles.push({ id: group.id, file: file.file });
    }
  }
  const indexEntries = indexesFor(projects).flatMap(index => index.value.entries
    .filter(entry => ids.has(entry.sessionId.toLowerCase()))
    .map(entry => ({ id: entry.sessionId.toLowerCase(), file: index.file })));
  const historyIds = removePromptHistory ? await remainingHistoryIds(home, ids) : [];
  return { ok: !remainingFiles.length && !indexEntries.length && !historyIds.length,
    checkedSessions: groups.length, remainingFiles, indexEntries, historyIds };
}

function snapshotOutcomes(result, outcomes) {
  result.outcomes = [...outcomes.values()];
  for (const status of ['deleted', 'failed', 'skipped']) {
    result[status] = result.outcomes.filter(item => item.status === status).map(({ status, ...item }) => item);
  }
}

export async function applyPreview(approved, { config, readConfig = loadConfig, desktopDirs,
  reportsDir = path.join(here, 'reports'), checkClosed = ensureClaudeClosed } = {}) {
  const old = new Map(approved.candidates.map(g => [g.id, g]));
  // One ledger owns every approved ID, including failures before scanning or acquiring a lock.
  const outcomes = new Map([...old.keys()].map(id => [id, { id, status: 'pending' }]));
  const record = (status, item) => outcomes.set(item.id, { ...item, status });
  const result = { ...approved, mode: 'apply', status: 'running', approvedSessions: old.size };
  delete result.reportPath; delete result.textReportPath;
  snapshotOutcomes(result, outcomes);
  const batch = path.join(reportsDir, 'backups', `${Date.now()}-${randomUUID()}`);
  let cleanupError, descriptor, lock;
  try {
    // Configuration is read inside the approval ledger's error boundary, never in argument defaults.
    const currentConfig = config === undefined ? await readConfig() : config;
    validateConfig(currentConfig);
    await checkClosed();
    const current = await preview({ home: approved.home, config: currentConfig, desktopDirs });
    const eligibleGroups = current.candidates.filter(group => old.has(group.id));
    const candidates = new Set(eligibleGroups.map(group => group.id));
    // Keep the approved report immutable in scope; observations cannot become approved candidates.
    result.revalidation = { createdAt: current.createdAt, days: current.days, pinState: current.pinState,
      totalSessions: current.totalSessions, candidateSessions: current.candidateSessions, eligibleSessions: eligibleGroups.length };
    for (const id of old.keys()) if (!candidates.has(id)) record('skipped', { id, reason: '재검증에서 제외됨' });
    requireVerifiedPins(readProtection(current.desktopDirs));
    if (approved.removePromptHistory !== current.removePromptHistory) {
      throw new Error('미리보기 이후 입력 이력 정리 옵션이 바뀌었습니다. 다시 미리보기로 확인하세요.');
    }
    // This lock is shared by all tool copies using the same Claude home.
    lock = path.join(current.home, '.session-cleanup.lock');
    descriptor = fs.openSync(lock, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    result.sharedBackupDir = path.join(batch, 'shared');
    result.journalPath = path.join(reportsDir, `${path.basename(batch)}-progress.jsonl`);
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(result.journalPath, '', { flag: 'wx' });
    const journal = event => fs.appendFileSync(result.journalPath, JSON.stringify(event) + '\n', { flush: true });
    const removedGroups = [];
    snapshotOutcomes(result, outcomes);
    writeReport(result, reportsDir);
    const metadata = await prepareMetadata(current.home, current.projects, candidates, current.removePromptHistory);
    await backupFiles(metadata.flatMap(plan => plan.files), result.sharedBackupDir);
    checkMetadata(metadata);
    for (const group of eligibleGroups) {
      const original = old.get(group.id);
      if (!sameFiles(original.files, group.files)) {
        record('skipped', { id: group.id, reason: '확인 이후 파일 변경' }); continue;
      }
      const attempt = { id: group.id, removed: [], backupDir: path.join(batch, group.id) };
      try {
        await checkClosed();
        let protection = readProtection(current.desktopDirs); requireVerifiedPins(protection);
        if (protection.pins.has(group.id)) { record('skipped', { id: group.id, reason: '새로 고정됨' }); continue; }
        if (!sameFiles(group.files, collectFiles(group, current.home))) throw new Error('삭제 전 파일이 변경되었습니다.');
        checkMetadata(metadata);
        await backupFiles(group.files, attempt.backupDir);
        await checkClosed();
        protection = readProtection(current.desktopDirs); requireVerifiedPins(protection);
        if (protection.pins.has(group.id)) throw new Error('백업 중 고정된 세션입니다.');
        if (!sameFiles(group.files, collectFiles(group, current.home))) throw new Error('백업 중 파일이 변경되었습니다.');
        checkMetadata(metadata);
        // Record the recovery location before the first destructive operation.
        journal({ event: 'group-start', id: group.id, backupDir: attempt.backupDir });
        for (const item of group.files) {
          checked(item.root, item.file);
          const fresh = inventory(item.root, item.file);
          if (!sameFiles([item], fresh)) throw new Error(`삭제 직전 파일이 변경되었습니다: ${item.file}`);
          fs.unlinkSync(item.file); attempt.removed.push(item.file);
          journal({ event: 'file-removed', id: group.id, file: item.file });
        }
        journal({ event: 'group-removed', id: group.id });
        removedGroups.push({ ...group, attempt });
      } catch (error) {
        record('failed', { ...attempt, error: error.message }); cleanupError = error;
        break;
      }
    }
    // Finish shared metadata for completely removed groups even if a later group failed.
    if (removedGroups.length) {
      try {
        await checkClosed(); requireVerifiedPins(readProtection(current.desktopDirs));
        const beforeMetadata = await verifyDeletedSessions(current.home, removedGroups, false);
        const stillPresent = new Set(beforeMetadata.remainingFiles.map(item => item.id));
        const completedIds = new Set(removedGroups.filter(g => !stillPresent.has(g.id)).map(g => g.id));
        journal({ event: 'metadata-start', ids: [...completedIds], backupDir: result.sharedBackupDir });
        result.metadata = completedIds.size ? await updateMetadata(metadata, completedIds) : { removedPromptEntries: 0 };
        journal({ event: 'metadata-updated' });
        result.verification = await verifyDeletedSessions(current.home, removedGroups, current.removePromptHistory);
        const remaining = new Set([...result.verification.remainingFiles, ...result.verification.indexEntries].map(item => item.id));
        for (const id of result.verification.historyIds) remaining.add(id);
        for (const group of removedGroups) {
          if (remaining.has(group.id)) record('failed', { ...group.attempt, error: '삭제 후 목록 또는 관련 파일에 항목이 남았습니다.' });
          else record('deleted', group.attempt);
        }
        if (!result.verification.ok) cleanupError ||= new Error('삭제 후 목록 검증에 실패했습니다.');
      } catch (error) {
        result.verification = { ok: false, error: error.message };
        for (const group of removedGroups) record('failed', { ...group.attempt, error: `사후 검증 실패: ${error.message}` });
        cleanupError ||= error;
      }
    } else result.verification = { ok: !cleanupError, checkedSessions: 0 };
  } catch (error) { cleanupError ||= error; }
  if (descriptor !== undefined) {
    try { fs.closeSync(descriptor); fs.unlinkSync(lock); }
    catch (error) { result.lockCleanupError = error.message; cleanupError ||= error; }
  }
  // Every return/throw uses this same terminal-state projection; pending IDs cannot disappear.
  for (const [id, item] of outcomes) {
    if (item.status === 'pending') record('skipped', { id,
      reason: cleanupError ? `작업 중단으로 미처리: ${cleanupError.message}` : '처리하지 않은 대상' });
  }
  result.status = cleanupError ? 'failed' : 'completed';
  if (cleanupError) result.operationError = cleanupError.message;
  result.verification ||= { ok: !cleanupError, checkedSessions: 0 };
  snapshotOutcomes(result, outcomes);
  try { writeReport(result, reportsDir); }
  catch (error) {
    result.reportWriteError = error.message; result.status = 'failed'; cleanupError ||= error;
  }
  if (cleanupError) {
    throw Object.assign(new Error(`정리를 중단했습니다. 백업과 보고서를 확인하세요: ${cleanupError.message}`,
      { cause: cleanupError }), { report: result });
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--json', '--preview'].includes(arg))) throw new Error('삭제는 manual.cmd의 확인 입력을 통해서만 실행하세요.');
    const result = await preview();
    writeReport(result, path.join(here, 'reports'));
    console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : formatPreview(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
