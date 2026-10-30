import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPreview, formatBytes, formatTextReport } from './output.mjs';

test('preview distinguishes missing logs from deletion and explains overlapping exclusions', () => {
  const report = { mode: 'preview', days: 7, totalSessions: 3842, candidateSessions: 2349,
    protectedSessions: 1493, candidateBytes: 0, protectionReasons: { recent: 1149, pinned: 52 },
    reportPath: 'result.json', textReportPath: 'result.txt',
    candidates: [{ rootId: 'root', title: '대상', ids: ['root'], bytes: 0,
      files: [{ id: 'root', exists: false }] }] };
  const text = formatPreview(report);
  assert.match(text, /마지막 활동이 7일 지난 세션/);
  assert.match(text, /최근 7일 안에 활동한 세션/);
  assert.match(text, /3,842개/); assert.match(text, /2,349개/);
  assert.match(text, /DB 항목만 정리/); assert.match(text, /확보 효과는 거의 없습니다/);
  assert.match(text, /여러 사유/); assert.match(text, /실제로 삭제한 세션은 없습니다/);
  assert.match(text, /result\.txt/); assert.doesNotMatch(text, /deletedSessions/);
  assert.match(formatTextReport(report), /대상 상세 목록/);
});

test('small nonzero file sizes never round down to zero GiB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(17), '17 B');
  assert.equal(formatBytes(1024), '1 KiB');
  assert.equal(formatBytes(2 ** 20), '1 MiB');
});
