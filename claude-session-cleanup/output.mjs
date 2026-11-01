export function size(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function formatPreview(report) {
  const reasons = new Map();
  for (const group of report.excluded) for (const reason of group.reasons) reasons.set(reason, (reasons.get(reason) || 0) + 1);
  return [
    `Claude Code 세션 정리 — ${report.days}일 기준 (미리보기)`,
    `전체 ${report.totalSessions}개 / 삭제 후보${report.deletionBlockedReasons?.length ? '(잠정)' : ''} ${report.candidateSessions}개 / 제외 ${report.excluded.length}개`,
    `고정 표시로 보호한 대화: ${report.pinCount}개`,
    ...(report.deletionBlockedReasons || []).map(reason => `실제 삭제 차단: ${reason}`),
    ...(report.protectionWarnings || []).map(warning => `고정 정보 경고: ${warning}`),
    `입력 이력: ${report.removePromptHistory ? '삭제 성공 대화의 이력 정리' : '보존'}`,
    `삭제 대상 원본 용량: ${size(report.candidateBytes)} (압축 백업 용량은 별도)`,
    ...[...reasons].map(([reason, count]) => `제외: ${reason} ${count}개`),
    ...(report.reportPath ? [`상세 보고서: ${report.textReportPath}`] : []),
    '이 결과는 조회만 수행했습니다. Claude가 실행 중이면 대상이 바뀔 수 있습니다.',
  ].join('\n');
}

export function formatResult(report) {
  return [`정리 결과: 승인 ${report.approvedSessions}개 / 삭제 ${report.deleted.length}개 / 건너뜀 ${report.skipped.length}개 / 실패 ${report.failed.length}개`,
    ...(report.operationError ? [`작업 오류: ${report.operationError}`] : []),
    ...(report.lockCleanupError ? [`잠금 해제 실패: ${report.lockCleanupError}`] : []),
    ...(report.reportWriteError ? [`보고서 저장 실패: ${report.reportWriteError}`] : []),
    `사후 목록 검증: ${report.verification?.ok ? '통과' : '실패 또는 미완료'}`,
    `보고서: ${report.textReportPath}`].join('\n');
}

export function formatTextReport(report) {
  const lines = [report.mode === 'apply' ? formatResult(report) : formatPreview(report), '', `Claude 저장 위치: ${report.home}`, ''];
  for (const group of report.candidates) {
    lines.push(`${report.mode === 'apply' ? '승인 대상' : '대상'}: ${group.id} (${size(group.bytes)})`);
    for (const main of group.mains) lines.push(`  ${main}`);
  }
  for (const group of report.excluded) lines.push(`제외: ${group.id} — ${group.reasons.join(', ')}`);
  for (const item of report.deleted || []) lines.push(`삭제: ${item.id} / 백업: ${item.backupDir}`);
  for (const item of report.skipped || []) lines.push(`건너뜀: ${item.id} — ${item.reason}`);
  for (const item of report.failed || []) lines.push(`실패: ${item.id} — ${item.error} / 백업: ${item.backupDir}`);
  if (report.sharedBackupDir) lines.push(`공유 메타데이터 백업: ${report.sharedBackupDir}`);
  if (report.revalidation) lines.push(`재조회 참고(${report.revalidation.days}일 기준): 전체 후보 ${report.revalidation.candidateSessions}개 / 승인 범위 내 실행 가능 ${report.revalidation.eligibleSessions}개`);
  if (report.journalPath) lines.push(`파일별 진행 기록: ${report.journalPath}`);
  if (report.metadata) lines.push(`정리한 입력 이력: ${report.metadata.removedPromptEntries}개`);
  if (report.verification?.error) lines.push(`사후 검증 오류: ${report.verification.error}`);
  if (report.inProgress) lines.push(`진행 중: ${report.inProgress.id} / 백업: ${report.inProgress.backupDir}`);
  return lines.join('\n') + '\n';
}
