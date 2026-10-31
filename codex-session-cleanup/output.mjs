const number = value => Number(value || 0).toLocaleString('ko-KR');
const reasonLabels = {
  pinned: '고정된 세션',
  'explicitly-protected': '별도로 보호한 세션',
  'loaded-or-running': '열려 있거나 실행 중인 세션',
  'invalid-path': '저장 경로를 확인하지 못한 세션',
  'missing-timestamp': '활동 시각을 확인하지 못한 세션',
  'missing-parent': '부모 세션을 확인하지 못한 세션',
  ephemeral: '임시 세션',
};

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: index ? 2 : 0 })} ${units[index]}`;
}

export function logCounts(report) {
  const files = (report.candidates || []).flatMap(group => group.files || []);
  return { existing: files.filter(file => file.exists).length,
    missing: files.filter(file => !file.exists).length };
}

export function formatPreview(report) {
  const counts = logCounts(report);
  const lines = [
    '',
    report.mode === 'preview' ? 'Codex 세션 정리 — 미리보기' : 'Codex 세션 정리 — 삭제 대상 확인',
    '────────────────────────────────────────',
    `정리 기준: 마지막 활동이 ${number(report.days)}일 지난 세션`,
    '',
    `전체 세션       : ${number(report.totalSessions)}개`,
    `삭제 대상       : ${number(report.candidateSessions)}개`,
    `보호·제외 대상  : ${number(report.protectedSessions)}개`,
    `예상 확보 용량  : ${formatBytes(report.candidateBytes)} (로그 파일 기준)`,
    '',
    '삭제 대상의 파일 상태',
    `  로그 파일 있음 : ${number(counts.existing)}개`,
    `  로그 파일 없음 : ${number(counts.missing)}개 — 남아 있는 DB 항목만 정리`,
  ];
  if (counts.missing && !counts.existing) {
    lines.push('  → 대상 로그가 이미 없어, 이번 정리의 디스크 용량 확보 효과는 거의 없습니다.');
  }
  if (report.candidates?.length && report.candidates.length !== report.candidateSessions) {
    lines.push(`  부모·자식 세션을 ${number(report.candidates.length)}개 묶음으로 처리합니다.`);
  }
  const reasons = Object.entries(report.protectionReasons || {});
  if (reasons.length) {
    lines.push('', '제외 사유 (한 세션이 여러 사유에 해당할 수 있음)');
    for (const [reason, count] of reasons) {
      const label = reason === 'recent' ? `최근 ${number(report.days)}일 안에 활동한 세션`
        : reasonLabels[reason] || reason;
      lines.push(`  ${label}: ${number(count)}개`);
    }
    lines.push('  보호 대상인 자식 세션이 있으면 해당 묶음 전체를 제외합니다.');
  }
  if (report.mode === 'preview') lines.push('', '미리보기만 실행했습니다. 실제로 삭제한 세션은 없습니다.');
  lines.push('', `상세 결과: ${report.textReportPath || report.reportPath}`);
  return lines.join('\n');
}

export function formatResult(report) {
  const deleted = report.deleted || [];
  const lines = ['', '삭제 결과', '────────────────────────────────────────',
    `삭제한 세션     : ${number(deleted.reduce((n,g) => n + g.ids.length, 0))}개`,
    `삭제한 로그 용량: ${formatBytes(deleted.reduce((n,g) => n + g.bytes, 0))}`,
    `조건 변경·건너뜀: ${number(report.skipped?.length)}개 묶음`,
    `실패           : ${number(report.failed?.length)}개 묶음`,
    `상세 결과      : ${report.textReportPath || report.reportPath}`];
  if (report.catalogCleanup) {
    lines.push(`정리한 목록 항목: ${number(report.catalogCleanup.removedRows)}개`);
    if (report.catalogCleanup.backupDirectory) lines.push(`목록 DB 백업    : ${report.catalogCleanup.backupDirectory}`);
  }
  if (report.catalogCleanupError) lines.push(`대화 목록 정리 실패: ${report.catalogCleanupError}`);
  return lines.join('\n');
}

function localDate(seconds) {
  if (!Number.isFinite(seconds)) return '시각 정보 없음';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium',
    timeStyle: 'short', hour12: false }).format(new Date(seconds * 1000));
}

export function formatTextReport(report) {
  const lines = [formatPreview(report)];
  if (report.mode === 'apply') lines.push(formatResult(report));
  if (report.error) lines.push('', `오류: ${report.error}`);
  lines.push('', '삭제 대상 상세 목록', '────────────────────────────────────────');
  if (!report.candidates?.length) lines.push('대상 없음');
  for (const group of report.candidates || []) {
    const title = String(group.title || group.rootId).replace(/[\r\n\t]/g, ' ');
    lines.push('', title,
      `  마지막 활동: ${localDate(group.updatedAt)}`,
      `  세션 수: ${number(group.ids.length)}개 / 로그 용량: ${formatBytes(group.bytes)}`,
      `  대표 ID: ${group.rootId}`);
    for (const file of group.files || []) {
      lines.push(`  ${file.exists ? '로그 있음' : '로그 없음(DB 항목)'}: ${file.id}`);
    }
  }
  if (report.failed?.length) {
    lines.push('', '실패 상세');
    for (const item of report.failed) lines.push(`${item.rootId}: ${item.error}`);
  }
  lines.push('', `원본 JSON: ${report.reportPath}`);
  return lines.join('\n') + '\n';
}
