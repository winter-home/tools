import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
    const details = processes.map(p => `${p.ProcessName} (PID ${p.Id})`).join(', ');
    throw new Error('Codex 앱과 Codex CLI/IDE 세션을 모두 종료한 뒤 다시 실행해 주세요. '
      + `실행 중인 Codex가 있어 변경하지 않았습니다: ${details}`);
  }
}
