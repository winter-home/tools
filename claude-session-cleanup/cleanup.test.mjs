import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { applyPreview, collectFiles, loadConfig, preview, verifyDeletedSessions } from './cleanup.mjs';
import { manual } from './manual.mjs';
import { desktopDirectories, readProtection } from './protection.mjs';
import { isClaudeProcess } from './processes.mjs';
import { atomicJson, backupFiles, checked, fileInventory } from './files.mjs';

const day = 86400000, old = Date.now() - 10 * day;
const config = { days: 7, protectedIds: [], desktopDataDirs: [] };
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cleanup-test-'));
  t.after(() => {
    assert.equal(path.dirname(base), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('claude-cleanup-test-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const home = path.join(base, '.claude'), desktop = path.join(base, 'desktop'), reportsDir = path.join(base, 'reports');
  fs.mkdirSync(home);
  const write = (file, value, time = old) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    fs.utimesSync(file, time / 1000, time / 1000); return file;
  };
  const session = ({ id = randomUUID(), project = 'D--test', timestamp = old, mtime = old, entrypoint = 'cli' } = {}) => {
    const file = write(path.join(home, 'projects', project, `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, timestamp: new Date(timestamp).toISOString(), entrypoint,
        message: { content: 'fixture message' } }) + '\n', mtime);
    return { id, file, project };
  };
  const desktopRecord = (session, { pinned = false, local = `local_${randomUUID()}`, time = old, legacy = [] } = {}) => {
    const cfg = write(path.join(desktop, 'claude_desktop_config.json'), { preferences: { epitaxyPrefs: {
      'starred-local-code-sessions': pinned ? [local] : [], 'dframe-local-slice': { pinnedOrder: legacy },
    } } });
    const file = write(path.join(desktop, 'claude-code-sessions', 'account', 'org', `${local}.json`),
      { sessionId: local, cliSessionId: session.id, lastActivityAt: time });
    return { cfg, file, local };
  };
  const scan = extra => preview({ home, config, desktopDirs: [], ...extra });
  const apply = (approved, extra) => applyPreview(approved, { config, desktopDirs: [], reportsDir, checkClosed: async () => {}, ...extra });
  return { base, home, desktop, reportsDir, write, session, desktopRecord, scan, apply };
}

test('7일 기준: 최근 파일, 최근 메시지, 최근 하위 에이전트는 모두 보존', async t => {
  const f = fixture(t), eligible = f.session(), fileRecent = f.session({ mtime: Date.now() }), messageRecent = f.session({ timestamp: Date.now() });
  const childRecent = f.session();
  f.write(path.join(path.dirname(childRecent.file), childRecent.id, 'subagents', 'agent-test.jsonl'),
    JSON.stringify({ type: 'assistant', sessionId: childRecent.id, timestamp: new Date().toISOString() }) + '\n');
  const result = await f.scan();
  assert.deepEqual(result.candidates.map(g => g.id), [eligible.id]);
  assert.equal(result.excluded.length, 3);
  assert.ok(result.excluded.find(g => g.id === messageRecent.id).reasons.includes('최근 대화'));
  assert.ok(result.excluded.find(g => g.id === childRecent.id).reasons.includes('최근 대화'));
  assert.ok(result.excluded.find(g => g.id === fileRecent.id).reasons.includes('최근 활동'));
});

test('고정 앱 ID를 실제 대화 UUID로 연결하고 추가 보호도 적용', async t => {
  const f = fixture(t), pinned = f.session({ entrypoint: 'claude-desktop' }), extra = f.session(), regular = f.session();
  f.desktopRecord(pinned, { pinned: true });
  const result = await f.scan({ desktopDirs: [f.desktop], config: { ...config, protectedIds: [extra.id] } });
  assert.deepEqual(result.candidates.map(g => g.id), [regular.id]);
  assert.equal(result.pinCount, 1);
  assert.ok(result.excluded.find(g => g.id === pinned.id).reasons.includes('고정'));
});

test('이전 고정 순서와 세션별 고정 표시도 보수적으로 보호', async t => {
  const f = fixture(t), session = f.session(), local = `local_${randomUUID()}`;
  const record = f.desktopRecord(session, { local, legacy: [`code:${local}`] });
  assert.ok(readProtection([f.desktop]).pins.has(session.id));
  const value = JSON.parse(fs.readFileSync(record.cfg));
  value.preferences.epitaxyPrefs['dframe-local-slice'].pinnedOrder = [];
  f.write(record.cfg, value);
  f.write(record.file, { sessionId: local, cliSessionId: session.id, isStarred: true });
  assert.ok(readProtection([f.desktop]).pins.has(session.id));
});

test('고정 정보 형식이나 ID 연결이 없으면 미리보기 경고로 남기고 삭제만 중단', async t => {
  const f = fixture(t), session = f.session();
  const r = f.desktopRecord(session);
  f.write(r.cfg, {});
  let scan = await f.scan({ desktopDirs: [f.desktop] });
  assert.ok(scan.protectionWarnings.some(w => w.includes('고정 목록 키')));
  assert.equal(scan.pinState, 'unverified');
  f.write(r.cfg, { preferences: { epitaxyPrefs: { 'starred-local-code-sessions': [`local_${randomUUID()}`] } } });
  scan = await f.scan({ desktopDirs: [f.desktop] });
  assert.ok(scan.protectionWarnings.some(w => w.includes('실제 대화 ID')));
  f.write(r.cfg, '{');
  scan = await f.scan({ desktopDirs: [f.desktop] });
  assert.ok(scan.protectionWarnings.length);
  assert.equal(scan.candidateSessions, 1);
  await assert.rejects(f.apply(scan, { desktopDirs: [f.desktop] }), /고정 원본/);
  assert.ok(fs.existsSync(session.file));
});

test('앱 연결 없는 desktop 로그, 손상 로그, 다른 ID 로그는 보존', async t => {
  const f = fixture(t), unmapped = f.session({ entrypoint: 'claude-desktop' }), bad = f.session(), mismatch = f.session();
  f.write(bad.file, '{broken\n');
  f.write(mismatch.file, JSON.stringify({ type: 'user', sessionId: randomUUID(), timestamp: new Date(old).toISOString() }));
  const result = await f.scan();
  assert.equal(result.candidateSessions, 0);
  assert.ok(result.excluded.find(g => g.id === unmapped.id).reasons.includes('앱 고정 상태 확인 불가'));
  assert.equal(result.excluded.length, 3);
});

test('같은 ID의 여러 프로젝트 파일을 하나로 보호하고 MCP 상태는 보존', async t => {
  const f = fixture(t), a = f.session();
  f.session({ id: a.id, project: 'other', mtime: Date.now() });
  const b = f.session(); f.write(path.join(path.dirname(b.file), b.id, 'mcp-tasks', 'state.json'), '{}');
  const result = await f.scan();
  assert.equal(result.totalSessions, 2); assert.equal(result.candidateSessions, 0);
});

test('앱 JSON 복제본은 미리보기의 보호 신호로만 사용', async t => {
  const f = fixture(t), orphan = f.session({ entrypoint: 'claude-desktop' }), pinned = f.session();
  f.desktopRecord(pinned, { pinned: true });
  const result = await f.scan({ desktopDirs: [f.desktop] });
  assert.deepEqual(result.candidates.map(g => g.id), [orphan.id]);
  assert.equal(result.deletionBlockedReasons.length, 1);
  await assert.rejects(f.apply(result, { desktopDirs: [f.desktop] }), /고정 원본/);
  assert.ok(fs.existsSync(orphan.file));
});

test('세션 junction은 정상 세션이 있어도 전체 조회와 삭제를 중단', async t => {
  const f = fixture(t), session = f.session(), normal = f.session(), outside = path.join(f.base, 'outside');
  const approved = await f.scan();
  const file = f.write(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(path.dirname(session.file), session.id), 'junction');
  await assert.rejects(f.scan(), /링크/);
  await assert.rejects(f.apply(approved), error => {
    assertAccounted(error.report, [session, normal]); assert.equal(error.report.deleted.length, 0); return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  assert.ok(fs.existsSync(normal.file)); assert.ok(fs.existsSync(session.file));
});

test('임시 CLI 데이터 삭제: 압축 백업, 인덱스 사후 검증, 사용자 파일 보존', async t => {
  const f = fixture(t), a = f.session(), keep = f.session({ mtime: Date.now() });
  const index = f.write(path.join(path.dirname(a.file), 'sessions-index.json'), { version: 1,
    entries: [{ sessionId: a.id }, { sessionId: keep.id }], preserved: true });
  f.write(path.join(path.dirname(a.file), a.id, 'tool-results', 'result.txt'), 'large tool result');
  f.write(path.join(f.home, 'file-history', a.id, 'file@v1'), 'checkpoint');
  const protectedFiles = [
    f.write(path.join(f.home, 'projects', a.project, 'memory', 'MEMORY.md'), 'memory'),
    f.write(path.join(f.home, 'plans', 'ongoing.md'), 'plan'),
    f.write(path.join(f.home, 'settings.json'), '{"cleanupPeriodDays":30}'),
    f.write(path.join(f.home, 'history.jsonl'), JSON.stringify({ sessionId: a.id, display: 'prompt' })),
  ];
  const before = new Map(protectedFiles.map(file => [file, fs.readFileSync(file)]));
  const scan = await f.scan();
  const original = fs.readFileSync(a.file);
  const result = await f.apply(scan);
  assert.equal(result.deleted.length, 1); assert.ok(!fs.existsSync(a.file));
  assert.equal(result.verification.ok, true);
  assert.ok(fs.existsSync(keep.file));
  assert.deepEqual(JSON.parse(fs.readFileSync(index)).entries, [{ sessionId: keep.id }]);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.deleted[0].backupDir, 'manifest.json')));
  const stored = manifest.files.find(entry => entry.original === a.file);
  assert.deepEqual(gunzipSync(fs.readFileSync(stored.backup)), original);
  for (const [file, content] of before) assert.deepEqual(fs.readFileSync(file), content);
  assert.equal((await f.scan()).totalSessions, 1);
});

test('고정 원본 미검증은 잠금 생성이나 백업보다 먼저 차단', async t => {
  const f = fixture(t), session = f.session(); f.desktopRecord(session);
  const scan = await f.scan({ desktopDirs: [f.desktop] });
  f.desktopRecord(session, { pinned: true });
  await assert.rejects(f.apply(scan, { desktopDirs: [f.desktop] }), /고정 원본/);
  assert.ok(fs.existsSync(session.file)); assert.ok(!fs.existsSync(path.join(f.reportsDir, 'backups')));
  assert.ok(!fs.existsSync(path.join(f.home, '.session-cleanup.lock')));
});

test('수동 실행도 원본 미검증이면 확인 입력을 요청하기 전에 중단', async t => {
  const f = fixture(t), session = f.session(); f.desktopRecord(session); let asked = false, applied = false;
  const configFile = f.write(path.join(f.base, 'config.json'), config);
  await assert.rejects(manual({ checkClosed: async () => {}, log: () => {}, reportsDir: f.reportsDir, configFile,
    scan: () => f.scan({ desktopDirs: [f.desktop] }),
    ask: async () => { asked = true; return 'DELETE 1'; }, apply: () => { applied = true; } }), /고정 원본/);
  assert.equal(asked, false); assert.equal(applied, false); assert.ok(fs.existsSync(session.file));
});

test('확인 뒤 파일 변경과 새 후보는 삭제 승인에 포함하지 않음', async t => {
  const f = fixture(t), session = f.session(); const scan = await f.scan();
  f.write(session.file, fs.readFileSync(session.file, 'utf8') + '\n');
  const added = f.session();
  const result = await f.apply(scan);
  assert.equal(result.deleted.length, 0); assert.equal(result.skipped.length, 1);
  assert.ok(fs.existsSync(session.file)); assert.ok(fs.existsSync(added.file));
});

test('백업 중 변경되면 원본을 삭제하지 않음', async t => {
  const f = fixture(t), session = f.session(); const scan = await f.scan(); let checks = 0;
  await assert.rejects(f.apply(scan, { checkClosed: async () => {
    if (++checks === 3) f.write(session.file, fs.readFileSync(session.file, 'utf8') + '\n');
  } }), error => {
    assert.match(error.message, /백업 중 파일/); assert.equal(error.report.failed[0].removed.length, 0); return true;
  });
  assert.ok(fs.existsSync(session.file)); assert.ok(!fs.existsSync(path.join(f.home, '.session-cleanup.lock')));
});

test('백업 중 새로 고정되면 원본을 삭제하지 않음', async t => {
  const f = fixture(t), session = f.session(); fs.mkdirSync(f.desktop);
  const scan = await f.scan({ desktopDirs: [f.desktop] }); let checks = 0;
  await assert.rejects(f.apply(scan, { desktopDirs: [f.desktop], checkClosed: async () => {
    if (++checks === 3) f.desktopRecord(session, { pinned: true });
  } }), /고정 원본/);
  assert.ok(fs.existsSync(session.file));
});

test('백업 쓰기 실패 시 원본을 삭제하지 않고 잠금을 해제', async t => {
  const f = fixture(t), session = f.session(); const scan = await f.scan();
  f.write(path.join(f.reportsDir, 'backups'), 'not a directory');
  await assert.rejects(f.apply(scan), /정리를 중단/);
  assert.ok(fs.existsSync(session.file)); assert.ok(!fs.existsSync(path.join(f.home, '.session-cleanup.lock')));
});

test('백업은 압축 동기화와 닫힘, manifest 동기화와 확정 순서로 완료', async t => {
  const f = fixture(t), session = f.session(), original = fs.readFileSync(session.file);
  const events = [], create = fs.createWriteStream, sync = fs.fsync, syncSync = fs.fsyncSync, rename = fs.renameSync;
  t.mock.method(fs, 'createWriteStream', (...args) => {
    const stream = create(...args);
    stream.on('close', () => events.push('gzip-close'));
    return stream;
  });
  t.mock.method(fs, 'fsync', (fd, callback) => sync(fd, error => {
    if (!error) events.push('gzip-sync');
    // Delay completion so an early backup return or manifest write is observable.
    setImmediate(() => callback(error));
  }));
  t.mock.method(fs, 'fsyncSync', fd => { syncSync(fd); events.push('manifest-sync'); });
  t.mock.method(fs, 'renameSync', (...args) => { rename(...args); events.push('manifest-rename'); });
  const manifest = await backupFiles(fileInventory(f.home, session.file), path.join(f.reportsDir, 'backup'));
  events.push('backup-complete');
  assert.deepEqual(events, ['gzip-sync', 'gzip-close', 'manifest-sync', 'manifest-rename', 'backup-complete']);
  assert.deepEqual(gunzipSync(fs.readFileSync(manifest[0].backup)), original);
  assert.deepEqual(fs.readFileSync(session.file), original);
  // Reports and other ordinary JSON writes keep their existing policy.
  atomicJson(path.join(f.reportsDir, 'ordinary.json'), {});
  assert.equal(events.filter(event => event === 'manifest-sync').length, 1);
});

test('압축 백업 동기화 실패 시 원본 삭제를 시작하지 않음', async t => {
  const f = fixture(t), session = f.session(), original = fs.readFileSync(session.file), scan = await f.scan();
  const failure = new Error('gzip fsync failure fixture');
  const sync = t.mock.method(fs, 'fsync', (fd, callback) => setImmediate(() => callback(failure)));
  await assert.rejects(f.apply(scan), error => {
    assert.equal(error.cause, failure); assert.equal(error.report.failed[0].removed.length, 0);
    assert.ok(!fs.existsSync(path.join(error.report.failed[0].backupDir, 'manifest.json')));
    return true;
  });
  assert.equal(sync.mock.callCount(), 1);
  assert.deepEqual(fs.readFileSync(session.file), original);
  assert.ok(!fs.existsSync(path.join(f.home, '.session-cleanup.lock')));
});

test('공유 또는 세션 manifest 동기화 실패 시 원본과 인덱스를 보존', async t => {
  for (const scope of ['shared', 'session']) await t.test(scope, async t => {
    const f = fixture(t), session = f.session();
    const index = f.write(path.join(path.dirname(session.file), 'sessions-index.json'), { entries: [{ sessionId: session.id }] });
    const before = [session.file, index].map(file => fs.readFileSync(file)), scan = await f.scan();
    const descriptors = new Map(), open = fs.openSync, sync = fs.fsyncSync;
    const failure = new Error(`${scope} manifest fsync failure fixture`);
    let failedFile;
    t.mock.method(fs, 'openSync', (...args) => {
      const fd = open(...args); descriptors.set(fd, args[0]); return fd;
    });
    t.mock.method(fs, 'fsyncSync', fd => {
      const file = descriptors.get(fd);
      if (typeof file === 'string' && path.basename(file) === `manifest.json.${process.pid}.tmp`
        && path.basename(path.dirname(file)) === (scope === 'shared' ? 'shared' : session.id)) {
        failedFile = file; throw failure;
      }
      return sync(fd);
    });
    await assert.rejects(f.apply(scan), error => {
      assert.equal(error.cause, failure); assert.equal(error.report.deleted.length, 0);
      assert.ok(error.report.failed.every(item => !item.removed.length)); return true;
    });
    assert.ok(failedFile);
    assert.ok(!fs.existsSync(path.join(path.dirname(failedFile), 'manifest.json')));
    [session.file, index].forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
    assert.ok(!fs.existsSync(path.join(f.home, '.session-cleanup.lock')));
  });
});

test('같은 인덱스의 여러 승인 세션을 순차 정리해도 새 항목을 유지', async t => {
  const f = fixture(t), a = f.session(), b = f.session(), keep = f.session({ mtime: Date.now() });
  const index = f.write(path.join(path.dirname(a.file), 'sessions-index.json'),
    { version: 1, entries: [a, b, keep].map(s => ({ sessionId: s.id })) });
  const result = await f.apply(await f.scan());
  assert.equal(result.deleted.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(index)).entries, [{ sessionId: keep.id }]);
});

test('일부 파일 삭제 실패 시 삭제 성공분과 복구 위치를 보고', async t => {
  const f = fixture(t), session = f.session();
  const attachment = f.write(path.join(path.dirname(session.file), session.id, 'tool-results', 'output.txt'), 'result');
  const scan = await f.scan();
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === attachment) throw new Error('fixture I/O failure');
    return unlink(file);
  });
  await assert.rejects(f.apply(scan), error => {
    assert.equal(error.report.failed.length, 1);
    assert.ok(fs.existsSync(path.join(error.report.failed[0].backupDir, 'manifest.json')));
    const saved = JSON.parse(fs.readFileSync(error.report.reportPath));
    assert.match(saved.failed[0].error, /fixture I\/O failure/); return true;
  });
  assert.ok(fs.existsSync(attachment));
});

test('손상 인덱스는 삭제 확인 전에 중단', async t => {
  const f = fixture(t), session = f.session();
  f.write(path.join(path.dirname(session.file), 'sessions-index.json'), '{bad');
  await assert.rejects(f.scan(), SyntaxError); assert.ok(fs.existsSync(session.file));
});

test('다른 정리 실행의 잠금이 있으면 삭제하지 않음', async t => {
  const f = fixture(t), session = f.session(); const scan = await f.scan();
  f.write(path.join(f.home, '.session-cleanup.lock'), '{}');
  await assert.rejects(f.apply(scan), /EEXIST/); assert.ok(fs.existsSync(session.file));
});

test('수동 실행은 정확한 확인 입력이 없으면 적용하지 않음', async t => {
  const f = fixture(t); f.session(); let applied = false;
  const configFile = f.write(path.join(f.base, 'config.json'), config);
  const result = await manual({ ask: async () => 'DELETE', log: () => {}, checkClosed: async () => {},
    scan: () => f.scan(), apply: () => { applied = true; }, configFile, reportsDir: f.reportsDir });
  assert.ok(result.cancelled); assert.equal(applied, false);
});

test('Claude 실행 차단은 미리보기와 삭제보다 먼저 수행', async t => {
  const f = fixture(t); let scanned = false;
  await assert.rejects(manual({ checkClosed: async () => { throw new Error('Claude PID 123'); },
    scan: () => { scanned = true; }, reportsDir: f.reportsDir }), /PID 123/);
  assert.equal(scanned, false);
});

test('프로세스 탐지는 Claude 네이티브 및 npm CLI만 분류', () => {
  assert.ok(isClaudeProcess({ Name: 'Claude.exe' }));
  assert.ok(isClaudeProcess({ Name: 'node.exe', CommandLine: 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' }));
  assert.equal(isClaudeProcess({ Name: 'node.exe', CommandLine: 'node D:\\tools\\claude-session-cleanup\\manual.mjs' }), false);
  assert.equal(isClaudeProcess({ Name: 'Code.exe' }), false);
});

test('현재 및 MSIX 앱 데이터 경로 발견과 최소 7일 설정 검증', t => {
  const f = fixture(t), local = path.join(f.base, 'Local');
  const relocated = path.join(local, 'Claude-Data', 'claude_test'); fs.mkdirSync(relocated, { recursive: true });
  const msix = path.join(local, 'Packages', 'Claude_test', 'LocalCache', 'Roaming', 'Claude'); fs.mkdirSync(msix, { recursive: true });
  assert.deepEqual(desktopDirectories({ LOCALAPPDATA: local }, 'win32').sort(), [relocated, msix].sort());
  const cfg = f.write(path.join(f.base, 'config.json'), { ...config, days: 6 });
  assert.throws(() => loadConfig(cfg), /7 이상/);
});

test('CLI --apply는 실제 홈에 접근하기 전에 거부', () => {
  const cli = fileURLToPath(new URL('./cleanup.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--apply'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /manual.cmd/);
});

test('앱 고정 원본과 JSON 복제본이 다를 수 있으면 빈 복제본도 신뢰하지 않음', async t => {
  const f = fixture(t), session = f.session({ entrypoint: 'claude-desktop' });
  const record = f.desktopRecord(session);
  f.write(path.join(f.desktop, 'IndexedDB', 'master-marker'), 'pin exists only in authoritative store');
  const originals = [record.cfg, record.file].map(file => [file, fs.readFileSync(file)]);
  const scan = await f.scan({ desktopDirs: [f.desktop] });
  assert.equal(scan.candidateSessions, 1); assert.equal(scan.pinCount, 0);
  assert.ok(!collectFiles(scan.candidates[0], f.home).some(item => item.file === record.file));
  await assert.rejects(f.apply(scan, { desktopDirs: [f.desktop] }), /고정 원본/);
  for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.ok(fs.existsSync(session.file));
});

test('입력 이력 옵션은 승인된 삭제 완료 ID만 정리하고 다른 줄의 원본 바이트 보존', async t => {
  const f = fixture(t), a = f.session(), keep = f.session({ mtime: Date.now() });
  const selected = { ...config, removePromptHistory: true };
  const removedLine = JSON.stringify({ sessionId: a.id, display: 'remove' }) + '\r\n';
  const retained = '\r\n' + JSON.stringify({ sessionId: keep.id, display: '보존', extra: [1, 2] })
    + '\r\n' + JSON.stringify({ display: 'legacy entry with no session ID' });
  const file = f.write(path.join(f.home, 'history.jsonl'), removedLine + retained);
  const result = await f.apply(await f.scan({ config: selected }), { config: selected });
  assert.equal(result.deleted.length, 1); assert.equal(result.metadata.removedPromptEntries, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), retained); assert.equal(result.verification.ok, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.sharedBackupDir, 'manifest.json')));
  const backup = manifest.files.find(entry => entry.original === file);
  assert.equal(gunzipSync(fs.readFileSync(backup.backup)).toString(), removedLine + retained);
});

test('입력 이력 손상 시 옵션을 켠 삭제는 시작하지 않음, 기본 보존이면 파일을 건드리지 않음', async t => {
  const f = fixture(t), session = f.session(), selected = { ...config, removePromptHistory: true };
  const history = f.write(path.join(f.home, 'history.jsonl'), '{broken');
  await assert.rejects(f.apply(await f.scan({ config: selected }), { config: selected }), error => {
    assert.ok(error.report.operationError); assert.equal(error.report.deleted.length, 0); return true;
  });
  assert.ok(fs.existsSync(session.file)); assert.equal(fs.readFileSync(history, 'utf8'), '{broken');
  assert.equal((await f.apply(await f.scan())).deleted.length, 1);
  assert.equal(fs.readFileSync(history, 'utf8'), '{broken');
});

test('확인 뒤 입력 이력 옵션이 바뀌면 다시 승인을 요구', async t => {
  const f = fixture(t), session = f.session(), scan = await f.scan();
  await assert.rejects(f.apply(scan, { config: { ...config, removePromptHistory: true } }), /옵션이 바뀌/);
  assert.ok(fs.existsSync(session.file));
});

test('중간 실패 뒤에도 완료 그룹의 인덱스와 입력 이력만 정리', async t => {
  const f = fixture(t), a = f.session({ id: '00000000-0000-0000-0000-000000000001' }),
    b = f.session({ id: '00000000-0000-0000-0000-000000000002' }), selected = { ...config, removePromptHistory: true };
  const index = f.write(path.join(path.dirname(a.file), 'sessions-index.json'), { entries: [a, b].map(g => ({ sessionId: g.id })) });
  const history = f.write(path.join(f.home, 'history.jsonl'), [a, b].map(g => JSON.stringify({ sessionId: g.id })).join('\n'));
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => { if (file === b.file) throw new Error('second group failure'); return unlink(file); });
  await assert.rejects(f.apply(await f.scan({ config: selected }), { config: selected }), error => {
    assert.equal(error.report.deleted.length, 1); assert.equal(error.report.failed.length, 1);
    assert.equal(error.report.verification.ok, true); return true;
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(index)).entries, [{ sessionId: b.id }]);
  assert.equal(JSON.parse(fs.readFileSync(history)).sessionId, b.id);
  assert.ok(fs.existsSync(b.file));
});

test('삭제 후 같은 로그가 다시 나타나면 성공으로 처리하지 않음', async t => {
  const f = fixture(t), session = f.session(), original = fs.readFileSync(session.file), unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => {
    unlink(file); if (file === session.file) fs.writeFileSync(file, original);
  });
  await assert.rejects(f.apply(await f.scan()), error => {
    assert.equal(error.report.deleted.length, 0); assert.equal(error.report.failed.length, 1);
    assert.equal(error.report.verification.ok, false);
    assert.ok(error.report.verification.remainingFiles.some(item => item.file === session.file)); return true;
  });
});

test('삭제 뒤 새 프로젝트 인덱스에 남은 ID도 검출', async t => {
  const f = fixture(t), session = f.session(), scan = await f.scan(); fs.unlinkSync(session.file);
  f.write(path.join(f.home, 'projects', 'new-project', 'sessions-index.json'), { entries: [{ sessionId: session.id }] });
  const result = await verifyDeletedSessions(f.home, scan.candidates, false);
  assert.equal(result.ok, false); assert.equal(result.indexEntries[0].id, session.id);
});

test('사후 목록 조회 실패를 성공으로 보고하지 않음', async t => {
  const f = fixture(t), session = f.session(), scan = await f.scan(), readdir = fs.readdirSync;
  let checks = 0, failVerification = false;
  t.mock.method(fs, 'readdirSync', (...args) => {
    if (failVerification && args[0] === path.join(f.home, 'projects')) throw new Error('verification I/O failure');
    return readdir(...args);
  });
  await assert.rejects(f.apply(scan, { checkClosed: async () => { if (++checks === 4) failVerification = true; } }), error => {
    assert.equal(error.report.deleted.length, 0); assert.equal(error.report.verification.ok, false);
    assert.match(error.report.verification.error, /verification I\/O failure/); return true;
  });
});

test('파일 수가 늘어도 전체 보고서는 시작과 종료에만 쓰고 파일별 기록은 작은 journal에 저장', async t => {
  const f = fixture(t), session = f.session(); f.session({ mtime: Date.now() });
  for (let i = 0; i < 25; i++) f.write(path.join(path.dirname(session.file), session.id, 'tool-results', `${i}.txt`), 'result');
  const rename = fs.renameSync; let reportsWritten = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.dirname(to) === f.reportsDir && to.endsWith('.json')) reportsWritten++;
    return rename(from, to);
  });
  const result = await f.apply(await f.scan());
  assert.equal(reportsWritten, 2);
  const events = fs.readFileSync(result.journalPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'file-removed').length, 26);
  assert.ok(events.every(e => !('candidates' in e) && !('excluded' in e)));
  assert.ok(!('files' in JSON.parse(fs.readFileSync(result.reportPath)).excluded[0]));
});

function assertAccounted(report, sessions) {
  const expected = sessions.map(session => session.id).sort();
  const outcomes = [...report.deleted, ...report.failed, ...report.skipped];
  assert.equal(report.approvedSessions, expected.length);
  assert.deepEqual(outcomes.map(item => item.id).sort(), expected);
  assert.deepEqual(report.outcomes.map(item => item.id).sort(), expected);
  assert.ok(report.outcomes.every(item => ['deleted', 'failed', 'skipped'].includes(item.status)));
}

test('미확인 앱 형식에서도 미리보기는 계속하고 삭제는 차단', async t => {
  const cases = [
    ['빈 설정만 있음', f => f.write(path.join(f.desktop, 'claude_desktop_config.json'), {})],
    ['고정 키 없이 IndexedDB만 있음', f => f.write(path.join(f.desktop, 'IndexedDB', 'marker'), 'database')],
    ['손상된 설정', f => f.write(path.join(f.desktop, 'claude_desktop_config.json'), '{broken')],
    ['객체가 아닌 설정', f => f.write(path.join(f.desktop, 'claude_desktop_config.json'), 'null')],
    ['연결 정보가 없는 앱 항목', (f, session) => {
      const record = f.desktopRecord(session); f.write(record.file, { sessionId: record.local });
    }],
    ['앱에서 없어진 과거 고정 ID', f => f.write(path.join(f.desktop, 'claude_desktop_config.json'),
      { preferences: { epitaxyPrefs: { 'dframe-local-slice': { pinnedOrder: [`code:local_${randomUUID()}`] } } } })],
    ['고정된 세션 그룹', f => f.write(path.join(f.desktop, 'claude_desktop_config.json'),
      { preferences: { epitaxyPrefs: { 'starred-session-groups': ['group-1'] } } })],
  ];
  for (const [name, setup] of cases) await t.test(name, async t => {
    const f = fixture(t), session = f.session(); setup(f, session);
    const scan = await f.scan({ desktopDirs: [f.desktop] });
    assert.equal(scan.candidateSessions, 1); assert.equal(scan.pinState, 'unverified');
    assert.equal(scan.deletionBlockedReasons.length, 1);
    await assert.rejects(f.apply(scan, { desktopDirs: [f.desktop] }), error => {
      assert.match(error.message, /고정 원본/); assertAccounted(error.report, [session]);
      assert.equal(error.report.skipped.length, 1); return true;
    });
    assert.ok(fs.existsSync(session.file));
    assert.ok(!fs.existsSync(path.join(f.home, '.session-cleanup.lock')));
    assert.ok(!fs.existsSync(path.join(f.reportsDir, 'backups')));
  });
});

test('고정 정보 경고가 있어도 다른 정상 고정 신호는 보존', async t => {
  const f = fixture(t), session = f.session(), record = f.desktopRecord(session, { pinned: true });
  const value = JSON.parse(fs.readFileSync(record.cfg));
  value.preferences.epitaxyPrefs['dframe-local-slice'].pinnedOrder = [`code:local_${randomUUID()}`];
  f.write(record.cfg, value);
  const scan = await f.scan({ desktopDirs: [f.desktop] });
  assert.ok(scan.protectionWarnings.some(warning => warning.includes('실제 대화 ID')));
  assert.equal(scan.pinCount, 1); assert.equal(scan.candidateSessions, 0);
});

test('JSON 형식 경고와 달리 앱 저장 경로의 junction은 여전히 거부', async t => {
  const f = fixture(t), session = f.session(), outside = path.join(f.base, 'outside');
  f.write(path.join(outside, 'marker'), 'keep'); fs.mkdirSync(f.desktop);
  fs.symlinkSync(outside, path.join(f.desktop, 'IndexedDB'), 'junction');
  await assert.rejects(f.scan({ desktopDirs: [f.desktop] }), /링크/);
  assert.ok(fs.existsSync(session.file));
});

test('앱 설정 접근 실패를 JSON 형식 경고로 숨기지 않음', async t => {
  const f = fixture(t); f.session(); const file = f.write(path.join(f.desktop, 'claude_desktop_config.json'), {});
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args) => {
    if (args[0] === file) throw Object.assign(new Error('access denied fixture'), { code: 'EACCES' });
    return read(...args);
  });
  await assert.rejects(f.scan({ desktopDirs: [f.desktop] }), /access denied/);
});

test('공유 백업 시작 전에 실패해도 승인 대상 전체를 미처리로 보고', async t => {
  const f = fixture(t), sessions = [f.session(), f.session(), f.session()], scan = await f.scan();
  f.write(path.join(f.reportsDir, 'backups'), 'not a directory');
  await assert.rejects(f.apply(scan), error => {
    assertAccounted(error.report, sessions); assert.equal(error.report.skipped.length, sessions.length);
    assert.ok(error.report.skipped.every(item => item.reason.includes('작업 중단으로 미처리')));
    assertAccounted(JSON.parse(fs.readFileSync(error.report.reportPath)), sessions); return true;
  });
  for (const session of sessions) assert.ok(fs.existsSync(session.file));
});

test('중간 그룹 실패 뒤 남은 승인 대상과 사전 제외 대상도 빠짐없이 집계', async t => {
  const f = fixture(t), sessions = [1, 2, 3, 4].map(n => f.session({ id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}` }));
  const scan = await f.scan(), unlink = fs.unlinkSync;
  // The last approved session is excluded by revalidation; the third is never started after failure.
  f.write(sessions[3].file, fs.readFileSync(sessions[3].file, 'utf8'), Date.now());
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === sessions[1].file) throw new Error('second group failure'); return unlink(file);
  });
  await assert.rejects(f.apply(scan), error => {
    assertAccounted(error.report, sessions);
    assert.equal(error.report.deleted.length, 1); assert.equal(error.report.failed.length, 1);
    assert.equal(error.report.skipped.length, 2);
    assert.match(error.report.skipped.find(item => item.id === sessions[2].id).reason, /미처리/);
    assert.match(error.report.skipped.find(item => item.id === sessions[3].id).reason, /재검증/); return true;
  });
});

test('승인 후 실행 전 차단된 경우에도 결과 보고서는 모든 ID를 포함', async t => {
  const f = fixture(t), sessions = [f.session(), f.session()], scan = await f.scan();
  await assert.rejects(f.apply(scan, { checkClosed: async () => { throw new Error('Claude reopened PID 123'); } }), error => {
    assertAccounted(error.report, sessions); assert.equal(error.report.skipped.length, 2);
    assert.match(error.report.operationError, /PID 123/); return true;
  });
});

test('수동 실행 실패도 요약과 보고서 경로를 출력하고 원래 오류를 전파', async t => {
  const f = fixture(t), session = f.session(), configFile = f.write(path.join(f.base, 'config.json'), config);
  const messages = [], original = new Error('fixture delete denied'), unlink = fs.unlinkSync;
  let thrown;
  t.mock.method(fs, 'unlinkSync', file => { if (file === session.file) throw original; return unlink(file); });
  await assert.rejects(manual({ checkClosed: async () => {}, log: message => messages.push(message),
    scan: () => f.scan(), ask: async () => 'DELETE 1', reportsDir: f.reportsDir, configFile,
    apply: async approved => {
      try { return await f.apply(approved); } catch (error) { thrown = error; throw error; }
    } }), error => {
    assert.equal(error, thrown); assert.equal(error.cause, original);
    assert.ok(messages.some(message => message.includes('정리 결과: 승인 1개') && message.includes('실패 1개')
      && message.includes(error.report.textReportPath))); return true;
  });
});

test('알려진 마커가 없는 비표준 앱 데이터도 미확인으로 보존', async t => {
  for (const relative of ['config.json', path.join('Partitions', 'new-profile', 'IndexedDB', 'marker')]) {
    await t.test(relative, async t => {
      const f = fixture(t), session = f.session(); f.write(path.join(f.desktop, relative), '{}');
      const scan = await f.scan({ desktopDirs: [f.desktop] });
      assert.equal(scan.pinState, 'unverified'); assert.equal(scan.candidateSessions, 1);
      assert.ok(scan.protectionWarnings.some(warning => warning.includes('저장 형식')));
      await assert.rejects(f.apply(scan, { desktopDirs: [f.desktop] }), /고정 원본/);
      assert.ok(fs.existsSync(session.file));
    });
  }
});

test('자동 발견된 앱 데이터에서도 형식과 무관하게 미확인 판정', async t => {
  const f = fixture(t), roaming = path.join(f.base, 'Roaming'), desktop = path.join(roaming, 'Claude');
  f.session(); f.write(path.join(desktop, 'future-storage.bin'), 'unknown format');
  const dirs = desktopDirectories({ APPDATA: roaming }, 'win32');
  assert.deepEqual(dirs, [desktop]);
  assert.equal((await f.scan({ desktopDirs: dirs })).pinState, 'unverified');
});

test('세션 파일 접근 거부는 다른 정상 세션이 있어도 전체 조회를 중단', async t => {
  const f = fixture(t), denied = f.session(), normal = f.session(), scan = await f.scan(), stat = fs.lstatSync;
  const original = Object.assign(new Error('session stat denied fixture'), { code: 'EACCES' });
  t.mock.method(fs, 'lstatSync', (...args) => { if (args[0] === denied.file) throw original; return stat(...args); });
  await assert.rejects(f.scan(), error => error === original);
  await assert.rejects(f.apply(scan), error => {
    assert.equal(error.cause, original); assertAccounted(error.report, [denied, normal]);
    assert.equal(error.report.deleted.length, 0); return true;
  });
  assert.ok(fs.existsSync(normal.file)); assert.ok(fs.existsSync(denied.file));
});

test('로그 스트림 읽기 오류도 내용 손상으로 숨기지 않고 전파', async t => {
  const f = fixture(t), denied = f.session(); f.session(); const stream = fs.createReadStream;
  const original = Object.assign(new Error('transcript read denied fixture'), { code: 'EACCES' });
  t.mock.method(fs, 'createReadStream', (file, ...args) => file === denied.file
    ? new Readable({ read() { this.destroy(original); } }) : stream(file, ...args));
  await assert.rejects(f.scan(), error => error === original);
});

test('승인 입력 중 설정 손상 또는 접근 실패도 전체 결과와 실패 요약을 남김', async t => {
  for (const failure of ['broken', 'EACCES']) await t.test(failure, async t => {
    const f = fixture(t), sessions = [f.session(), f.session()], configFile = f.write(path.join(f.base, 'config.json'), config);
    const logs = [], read = fs.readFileSync;
    const original = Object.assign(new Error('config read denied fixture'), { code: 'EACCES' });
    let confirmed = false;
    t.mock.method(fs, 'readFileSync', (...args) => {
      if (confirmed && failure === 'EACCES' && args[0] === configFile) throw original;
      return read(...args);
    });
    await assert.rejects(manual({ checkClosed: async () => {}, configFile, reportsDir: f.reportsDir,
      scan: () => f.scan(), log: message => logs.push(message),
      ask: async () => { confirmed = true; if (failure === 'broken') f.write(configFile, '{broken'); return 'DELETE 2'; },
      apply: (approved, options) => applyPreview(approved, { ...options, desktopDirs: [] }),
    }), error => {
      assertAccounted(error.report, sessions);
      assert.equal(error.report.skipped.length, 2); assert.equal(error.report.deleted.length, 0);
      assert.ok(logs.some(log => log.includes('정리 결과: 승인 2개') && log.includes(error.report.textReportPath)));
      if (failure === 'EACCES') assert.equal(error.cause, original);
      else assert.ok(error.cause instanceof SyntaxError);
      assertAccounted(JSON.parse(fs.readFileSync(error.report.reportPath)), sessions); return true;
    });
    for (const session of sessions) assert.ok(fs.existsSync(session.file));
    assert.ok(!fs.existsSync(path.join(f.reportsDir, 'backups')));
  });
});

test('설정 로더 실패가 함수 기본 인자에서 빠져나가지 않고 결과 원장에 포함', async t => {
  const f = fixture(t), session = f.session(), scan = await f.scan(), original = new Error('config provider failure');
  await assert.rejects(applyPreview(scan, { desktopDirs: [], reportsDir: f.reportsDir, checkClosed: async () => {},
    readConfig: () => { throw original; } }), error => {
    assert.equal(error.cause, original); assertAccounted(error.report, [session]); return true;
  });
  assert.ok(fs.existsSync(session.file));
});

test('사전 차단 보고서는 새로 발견한 미승인 세션을 대상에 포함하지 않음', async t => {
  for (const barrier of ['history-option', 'pins']) await t.test(barrier, async t => {
    const f = fixture(t), session = f.session(); fs.mkdirSync(f.desktop);
    const scan = await f.scan({ desktopDirs: [f.desktop] }), added = f.session();
    const options = { desktopDirs: [f.desktop] };
    if (barrier === 'history-option') options.config = { ...config, removePromptHistory: true };
    else f.desktopRecord(session);
    await assert.rejects(f.apply(scan, options), error => {
      const report = error.report;
      assert.deepEqual(report.candidates.map(group => group.id), [session.id]);
      assert.equal(report.candidateSessions, scan.candidateSessions); assert.equal(report.candidateBytes, scan.candidateBytes);
      assert.equal(report.revalidation.candidateSessions, 2); assert.equal(report.revalidation.eligibleSessions, 1);
      assertAccounted(report, [session]);
      assert.ok(!fs.readFileSync(report.textReportPath, 'utf8').includes(added.id));
      assert.deepEqual(JSON.parse(fs.readFileSync(report.reportPath)).candidates.map(group => group.id), [session.id]); return true;
    });
    assert.ok(fs.existsSync(session.file)); assert.ok(fs.existsSync(added.file));
  });
});

test('허용 루트 자체가 일반 폴더여도 그 부모가 junction이면 거부', async t => {
  const f = fixture(t), physical = path.join(f.base, 'physical'), alias = path.join(f.base, 'alias');
  const home = path.join(physical, '.claude'), desktop = path.join(physical, 'desktop'), id = randomUUID();
  const log = f.write(path.join(home, 'projects', 'test', `${id}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: id, timestamp: new Date(old).toISOString(), entrypoint: 'cli' }) + '\n');
  f.write(path.join(desktop, 'claude_desktop_config.json'), {});
  const original = fs.readFileSync(log);
  assert.ok(checked(home, log).isFile());
  assert.equal((await preview({ home, config, desktopDirs: [] })).candidateSessions, 1);
  fs.symlinkSync(physical, alias, 'junction');
  const aliasHome = path.join(alias, '.claude');
  assert.equal(fs.lstatSync(aliasHome).isSymbolicLink(), false);
  assert.throws(() => checked(aliasHome, path.join(aliasHome, 'projects', 'test', `${id}.jsonl`)), /링크/);
  await assert.rejects(preview({ home: aliasHome, config, desktopDirs: [] }), /링크/);
  assert.throws(() => readProtection([path.join(alias, 'desktop')]), /링크/);
  assert.deepEqual(fs.readFileSync(log), original);
});

test('비문자열 앱 대화 ID는 경고로 처리하고 잠정 조회 및 삭제 차단 유지', async t => {
  const id = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  for (const [name, value] of [['UUID 한 개 배열', [id]], ['숫자', 42], ['null', null], ['객체', { id }]]) {
    await t.test(name, async t => {
      const f = fixture(t), session = f.session({ id }), record = f.desktopRecord(session);
      f.write(record.file, { sessionId: record.local, cliSessionId: value, isStarred: true });
      const original = fs.readFileSync(record.file), scan = await f.scan({ desktopDirs: [f.desktop] });
      assert.equal(scan.pinState, 'unverified'); assert.equal(scan.candidateSessions, 1);
      assert.ok(scan.protectionWarnings.length > 0);
      assert.equal(readProtection([f.desktop]).records.length, 0);
      await assert.rejects(f.apply(scan, { desktopDirs: [f.desktop] }), /고정 원본/);
      assert.ok(fs.existsSync(session.file)); assert.deepEqual(fs.readFileSync(record.file), original);
    });
  }
});

test('앱 목록과 레코드의 문자열 UUID는 같은 방식으로 정규화', async t => {
  const f = fixture(t), session = f.session({ id: 'abcdefab-cdef-4abc-8def-abcdefabcdef' });
  const local = 'local_12345678-abcd-4abc-8def-123456789abc';
  const record = f.desktopRecord(session, { pinned: true, local });
  const upperLocal = `local_${local.slice(6).toUpperCase()}`;
  f.write(record.cfg, { preferences: { epitaxyPrefs: { 'starred-local-code-sessions': [upperLocal] } } });
  f.write(record.file, { sessionId: upperLocal, cliSessionId: session.id.toUpperCase(), lastActivityAt: old });
  const protection = readProtection([f.desktop]);
  assert.deepEqual([...protection.pins], [session.id]);
  assert.equal(protection.records[0].id, local); assert.equal(protection.records[0].cliId, session.id);
  assert.equal(protection.warnings.length, 0);
  const scan = await f.scan({ desktopDirs: [f.desktop] });
  assert.equal(scan.pinCount, 1); assert.equal(scan.candidateSessions, 0);
});

test('UUID.jsonl 이름의 디렉터리 내부는 세션으로 수집하거나 삭제하지 않음', async t => {
  const f = fixture(t), normal = f.session(), fakeId = randomUUID();
  const fakeMain = path.join(path.dirname(normal.file), `${fakeId}.jsonl`);
  const text = f.write(path.join(fakeMain, 'keep.txt'), 'not a transcript');
  const nested = f.write(path.join(fakeMain, 'nested.jsonl'), JSON.stringify({ type: 'user', sessionId: fakeId,
    timestamp: new Date(old).toISOString(), entrypoint: 'cli' }) + '\n');
  const original = fs.readFileSync(nested);
  assert.throws(() => collectFiles({ id: fakeId, mains: [fakeMain] }, f.home), /일반 파일/);
  const scan = await f.scan();
  assert.equal(scan.totalSessions, 1); assert.deepEqual(scan.candidates.map(group => group.id), [normal.id]);
  const result = await f.apply(scan);
  assert.equal(result.deleted.length, 1);
  assert.equal(fs.readFileSync(text, 'utf8'), 'not a transcript');
  assert.deepEqual(fs.readFileSync(nested), original);
});

test('부속 로그가 정상이어도 빈 메인 로그는 삭제 후보가 되지 않음', async t => {
  const f = fixture(t), session = f.session(); f.write(session.file, '');
  const attachment = f.write(path.join(path.dirname(session.file), session.id, 'subagents', 'agent-test.jsonl'),
    JSON.stringify({ type: 'assistant', sessionId: session.id, timestamp: new Date(old).toISOString() }) + '\n');
  const scan = await f.scan();
  assert.equal(scan.candidateSessions, 0);
  assert.ok(scan.excluded[0].reasons.some(reason => reason.includes('검증 실패')));
  assert.ok(fs.existsSync(attachment));
});

test('같은 ID의 메인 로그가 여러 개면 모두 검증해야 함', async t => {
  const f = fixture(t), session = f.session(), second = f.session({ id: session.id, project: 'second' });
  f.write(second.file, '');
  const scan = await f.scan();
  assert.equal(scan.totalSessions, 1); assert.equal(scan.candidateSessions, 0);
  assert.equal(scan.excluded[0].mains.length, 2);
  assert.ok(scan.excluded[0].reasons.some(reason => reason.includes('검증 실패')));
  assert.ok(fs.existsSync(session.file));
});

test('확인 후 메인 로그가 없어지면 남은 부속 자료는 정리하지 않음', async t => {
  const f = fixture(t), session = f.session();
  const attachment = f.write(path.join(path.dirname(session.file), session.id, 'tool-results', 'keep.txt'), 'preserve');
  const approved = await f.scan(); fs.unlinkSync(session.file);
  const result = await f.apply(approved);
  assert.equal(result.deleted.length, 0); assert.equal(result.skipped.length, 1);
  assert.equal(fs.readFileSync(attachment, 'utf8'), 'preserve');
  assert.equal((await f.scan()).totalSessions, 0);
});

test('혼합 고정 목록은 잘못된 원소 전후의 정상 ID와 legacy 목록을 모두 보존', async t => {
  const f = fixture(t), sessions = [f.session(), f.session(), f.session()];
  const records = sessions.map(session => f.desktopRecord(session));
  f.write(records[0].cfg, { preferences: { epitaxyPrefs: {
    'starred-local-code-sessions': [records[0].local, 42, records[1].local],
    'dframe-local-slice': { pinnedOrder: ['dispatch:unknown', `code:${records[2].local}`] },
    'starred-session-groups': ['group-1'],
  } } });
  const scan = await f.scan({ desktopDirs: [f.desktop] });
  assert.equal(scan.pinCount, 3); assert.equal(scan.candidateSessions, 0);
  for (const session of sessions) assert.ok(scan.excluded.find(group => group.id === session.id).reasons.includes('고정'));
  assert.ok(scan.protectionWarnings.some(warning => warning.includes('starred-local-code-sessions') && warning.includes('원소 2')));
  assert.ok(scan.protectionWarnings.some(warning => warning.includes('pinnedOrder') && warning.includes('원소 1')));
  assert.ok(scan.protectionWarnings.some(warning => warning.includes('고정된 그룹')));
});

test('현재 고정 목록 자체가 잘못돼도 정상 legacy 목록을 수집', async t => {
  const f = fixture(t), session = f.session(), record = f.desktopRecord(session);
  f.write(record.cfg, { preferences: { epitaxyPrefs: {
    'starred-local-code-sessions': { invalid: true },
    'dframe-local-slice': { pinnedOrder: [`code:${record.local}`] },
    'starred-session-groups': ['group-1'],
  } } });
  const scan = await f.scan({ desktopDirs: [f.desktop] });
  assert.equal(scan.pinCount, 1); assert.equal(scan.candidateSessions, 0);
  assert.ok(scan.protectionWarnings.some(warning => warning.includes('배열이 아닙니다')));
  assert.ok(scan.protectionWarnings.some(warning => warning.includes('고정된 그룹')));
  await assert.rejects(f.apply(scan, { desktopDirs: [f.desktop] }), /고정 원본/);
  assert.ok(fs.existsSync(session.file));
});
