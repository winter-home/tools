import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repairCatalog, readDeletionReports } from './catalog.mjs';
import { ensureCodexClosed } from './processes.mjs';
import { loadSqlite } from './runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function repairList({ previewOnly = false, ask, log = console.log,
  home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  reportsDir = path.join(here, 'reports'), checkClosed = ensureCodexClosed,
  checkRuntime = loadSqlite, repair = repairCatalog } = {}) {
  await checkRuntime();
  if (!previewOnly) await checkClosed();
  const { reports, skippedReports } = readDeletionReports(home, reportsDir);
  for (const item of skippedReports) log(`건너뛴 보고서: ${item.file}\n  사유: ${item.error}`);
  const finish = result => {
    if (skippedReports.length) log(`주의: 보고서 ${skippedReports.length}개를 건너뛰었습니다. 해당 보고서에만 기록된 항목은 정리하지 않았습니다.`);
    return { ...result, skippedReports };
  };
  const options = { home, reports, backupDir: path.join(reportsDir, 'catalog-backups'), checkClosed };
  const preview = await repair(options);
  log(`대화 목록에서 정리할 항목: ${preview.entryCount.toLocaleString('ko-KR')}개`);
  log('과거 삭제 보고서에 기록되어 있고 본문과 현재 세션 DB에 없는 항목만 목록에서 정리합니다.');
  if (previewOnly || !preview.entryCount) return finish(preview);
  const expected = `CLEAN ${preview.entryCount}`;
  if ((await ask(`계속하려면 ${expected} 입력 (Enter는 취소): `)).trim() !== expected) {
    log('취소했습니다. 대화 목록을 변경하지 않았습니다.');
    return finish({ cancelled: true });
  }
  const result = await repair({ ...options, apply: true,
    approvedIds: preview.databases.flatMap(d => d.ids) });
  log(`정리한 목록 항목: ${result.removedRows.toLocaleString('ko-KR')}개`);
  if (result.backupDirectory) log(`목록 DB 백업 및 처리 기록: ${result.backupDirectory}`);
  return finish(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--preview')) { console.error('Usage: node repair-list.mjs [--preview]'); process.exitCode = 1; }
  else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    repairList({ previewOnly: args.includes('--preview'), ask: question => rl.question(question) })
      .catch(e => { console.error(e.message); process.exitCode = 1; })
      .finally(() => rl.close());
  }
}
