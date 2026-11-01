import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyPreview, here, loadConfig, preview, writeReport } from './cleanup.mjs';
import { ensureClaudeClosed } from './processes.mjs';
import { readProtection, requireVerifiedPins } from './protection.mjs';
import { formatPreview, formatResult } from './output.mjs';

export async function manual({ ask, log = console.log, checkClosed = ensureClaudeClosed,
  scan = preview, apply = applyPreview, reportsDir = path.join(here, 'reports'), configFile } = {}) {
  await checkClosed();
  const config = loadConfig(configFile);
  const result = await scan({ config });
  writeReport(result, reportsDir); log(formatPreview(result));
  requireVerifiedPins(readProtection(result.desktopDirs));
  if (!result.candidateSessions) return { cancelled: true };
  const expected = `DELETE ${result.candidateSessions}`;
  log('확인한 대상만 압축 백업 후 영구 삭제합니다. 완료될 때까지 Claude를 닫아 두세요.');
  const answer = await ask(`계속하려면 ${expected} 입력 (Enter는 취소): `);
  if (answer.trim() !== expected) { log('취소했습니다. 세션을 삭제하지 않았습니다.'); return { cancelled: true }; }
  let applied, applyError;
  try { applied = await apply(result, { readConfig: () => loadConfig(configFile), reportsDir, checkClosed }); }
  catch (error) {
    if (!error.report) throw error;
    applied = error.report; applyError = error;
  }
  log(formatResult(applied));
  if (applyError) throw applyError;
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  manual({ ask: question => rl.question(question) })
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => rl.close());
}
