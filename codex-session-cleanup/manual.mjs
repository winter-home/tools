import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './cleanup.mjs';
import { formatResult, formatTextReport } from './output.mjs';
import { repairCatalog } from './catalog.mjs';
import { ensureCodexClosed } from './processes.mjs';
import { loadSqlite } from './runtime.mjs';
export { ensureCodexClosed } from './processes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function manual({ checkClosed = ensureCodexClosed, runCleanup = run,
  checkRuntime = loadSqlite, syncCatalog = repairCatalog, ask, log = console.log,
  protectionFile = path.join(here, 'runtime-manual-protected.json'),
  backupDir = path.join(here, 'reports', 'catalog-backups') } = {}) {
  await checkRuntime();
  await checkClosed();
  log('Codex 세션 정리 — 완료될 때까지 Codex를 닫아 두세요.');
  const preview = await runCleanup();
  if (!preview.candidateSessions) { log('삭제할 세션이 없습니다.'); return { cancelled: true }; }
  const expected = `DELETE ${preview.candidateSessions}`;
  log('확인한 대상만 영구 삭제합니다. 취소하려면 Enter를 누르세요.');
  const response = await ask(`계속하려면 ${expected} 입력: `);
  if (response.trim() !== expected) { log('취소했습니다. 세션을 삭제하지 않았습니다.'); return { cancelled: true }; }
  await new Promise(resolve => setTimeout(resolve, 100));
  await checkClosed();
  fs.writeFileSync(protectionFile, '[]\n', 'utf8');
  let result, cleanupError;
  try {
    result = await runCleanup({ apply: true, protectFile: protectionFile,
      approvedGroups: preview.candidates, output: 'quiet' });
  } catch (error) {
    if (!error.report) throw error;
    result = error.report;
    cleanupError = error;
  }
  let catalogError;
  try {
    // Let the cleanup app-server finish exiting before checking for live Codex processes.
    await new Promise(resolve => setTimeout(resolve, 100));
    result.catalogCleanup = await syncCatalog({ home: result.home, reports: [result],
      apply: true, backupDir, checkClosed });
  } catch (error) {
    catalogError = error;
    result.catalogCleanupError = error.message;
  }
  if (result.reportPath) fs.writeFileSync(result.reportPath, JSON.stringify(result, null, 2));
  if (result.textReportPath) fs.writeFileSync(result.textReportPath, '\uFEFF' + formatTextReport(result), 'utf8');
  log(formatResult(result));
  if (catalogError) {
    const message = '대화 목록 정리에 실패했습니다. '
      + `Codex를 종료한 뒤 repair-list.cmd로 다시 시도해 주세요.\n${catalogError.message}`;
    if (!cleanupError) throw Object.assign(new Error(message, { cause: catalogError }), { report: result });
    log(message);
  }
  if (cleanupError) throw cleanupError;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  manual({ ask: question => rl.question(question) })
    .catch(e => { console.error(e.message); process.exitCode = 1; })
    .finally(() => rl.close());
}
