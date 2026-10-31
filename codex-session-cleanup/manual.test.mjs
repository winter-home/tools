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
    syncCatalog: async options => { assert.equal(options.apply, true);
      assert.equal(options.reports[0].deleted[0].ids[0], 'old-root');
      return { removedRows: 1 }; },
    log: () => {}, ask: async () => 'DELETE 1', runCleanup: async options => {
      calls++;
      if (!options) return { candidateSessions: 1, candidateBytes: 10, candidates: approved };
      assert.equal(options.apply, true); assert.deepEqual(options.approvedGroups, approved);
      assert.deepEqual(JSON.parse(fs.readFileSync(options.protectFile, 'utf8')), []);
      return { deleted: [{ ids: ['old-root'], bytes: 10 }] };
    } });
  assert.equal(checks, 2); assert.equal(calls, 2);
});

test('a catalog failure preserves the successful deletion result and explains how to retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manual-test-'));
  const result = { deleted: [{ ids: ['old-root'], bytes: 10 }], reportPath: path.join(dir, 'apply.json') };
  await assert.rejects(manual({ protectionFile: path.join(dir, 'protected.json'),
    checkClosed: async () => {}, ask: async () => 'DELETE 1', log: () => {},
    syncCatalog: async () => { throw new Error('catalog locked'); },
    runCleanup: async options => options ? result : { candidateSessions: 1, candidates: [] },
  }), /repair-list.cmd/);
  const saved = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
  assert.equal(saved.deleted.length, 1);
  assert.equal(saved.catalogCleanupError, 'catalog locked');
});

test('combined deletion and catalog failures preserve the original error and recovery instructions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manual-test-'));
  const report = { mode: 'apply', error: 'deletion failed', deleted: [{ ids: ['old-root'], bytes: 10 }],
    reportPath: path.join(dir, 'apply.json'), textReportPath: path.join(dir, 'apply.txt') };
  const failure = Object.assign(new Error(report.error), { report });
  const messages = [];
  await assert.rejects(manual({ protectionFile: path.join(dir, 'protected.json'),
    checkClosed: async () => {}, ask: async () => 'DELETE 1', log: text => messages.push(text),
    runCleanup: async options => {
      if (!options) return { candidateSessions: 1, candidates: [] };
      throw failure;
    },
    syncCatalog: async options => { assert.equal(options.reports[0], report); throw new Error('catalog locked'); },
  }), error => error === failure);
  const saved = JSON.parse(fs.readFileSync(report.reportPath, 'utf8'));
  assert.equal(saved.error, 'deletion failed');
  assert.equal(saved.catalogCleanupError, 'catalog locked');
  assert.match(fs.readFileSync(report.textReportPath, 'utf8'), /deletion failed/);
  assert(messages.some(text => text.includes('repair-list.cmd')));
});
