import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { manual } from './manual.mjs';

test('manual cleanup refuses to run while Codex is open', async () => {
  let touched = false;
  await assert.rejects(manual({ checkClosed: async () => { throw new Error('still running'); },
    runCleanup: async () => { touched = true; } }), /still running/);
  assert.equal(touched, false);
});

test('Enter cancels after preview without deleting', async () => {
  let calls = 0;
  const result = await manual({ checkClosed: async () => {}, log: () => {}, ask: async () => '',
    runCleanup: async options => { calls++; assert.equal(options, undefined);
      return { candidateSessions: 2, candidateBytes: 10, candidates: [] }; } });
  assert.equal(calls, 1); assert.equal(result.cancelled, true);
});

test('manual deletion requires confirmation and limits deletion to reviewed families', async () => {
  let calls = 0, checks = 0;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manual-test-')), 'protected.json');
  const approved = [{ rootId: 'old-root', ids: ['old-root'] }];
  await manual({ protectionFile: file, checkClosed: async () => { checks++; },
    log: () => {}, ask: async () => 'DELETE 1', runCleanup: async options => {
      calls++;
      if (!options) return { candidateSessions: 1, candidateBytes: 10, candidates: approved };
      assert.equal(options.apply, true); assert.deepEqual(options.approvedGroups, approved);
      assert.deepEqual(JSON.parse(fs.readFileSync(options.protectFile, 'utf8')), []);
      return { deleted: [{ ids: ['old-root'], bytes: 10 }] };
    } });
  assert.equal(checks, 2); assert.equal(calls, 2);
});
