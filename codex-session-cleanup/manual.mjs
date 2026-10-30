import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './cleanup.mjs';
import { formatResult } from './output.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);

export async function ensureCodexClosed() {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "$ErrorActionPreference='Stop'; @(@(Get-Process -Name Codex -ErrorAction SilentlyContinue) | Select-Object Id,ProcessName) | ConvertTo-Json -Compress";
  const { stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000 });
  const value = stdout.trim();
  const parsed = value ? JSON.parse(value) : [];
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  if (processes.length) {
    throw new Error('Codex 앱과 Codex CLI/IDE 세션을 모두 종료한 뒤 manual.cmd를 다시 실행해 주세요. 실행 중인 Codex가 있어 삭제하지 않았습니다.');
  }
}

export async function manual({ checkClosed = ensureCodexClosed, runCleanup = run,
  ask, log = console.log, protectionFile = path.join(here, 'runtime-manual-protected.json') } = {}) {
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
  const result = await runCleanup({ apply: true, protectFile: protectionFile,
    approvedGroups: preview.candidates, output: 'quiet' });
  log(formatResult(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  manual({ ask: question => rl.question(question) })
    .catch(e => { console.error(e.message); process.exitCode = 1; })
    .finally(() => rl.close());
}
