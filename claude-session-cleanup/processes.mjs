import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function isClaudeProcess(process) {
  if (/^claude(?:[-_].*)?(?:\.exe)?$/i.test(process.Name || '')) return true;
  return /^(?:node|bun)(?:\.exe)?$/i.test(process.Name || '')
    && /@anthropic-ai[\\/](?:claude-code|claude-agent-sdk)(?:[\\/]|\b)/i.test(process.CommandLine || '');
}

export async function ensureClaudeClosed() {
  if (process.platform !== 'win32') throw new Error('수동 삭제는 Windows에서만 지원합니다.');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(claude.*|node|bun)(\\.exe)?$' } | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress";
  const { stdout } = await promisify(execFile)(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  const value = stdout.trim() ? JSON.parse(stdout) : [];
  const processes = (Array.isArray(value) ? value : [value]).filter(isClaudeProcess);
  if (processes.length) throw new Error('Claude 앱과 Claude Code CLI/IDE 세션을 모두 종료한 뒤 다시 실행해 주세요. '
    + '실행 중인 Claude가 있어 변경하지 않았습니다: '
    + processes.map(p => `${p.Name} (PID ${p.ProcessId})`).join(', '));
}
