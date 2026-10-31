import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSqlite } from './runtime.mjs';
import { manual } from './manual.mjs';
import { repairList } from './repair-list.mjs';

for (const [name, entry] of [['manual', manual], ['repair-list', repairList]]) {
  test(`${name} rejects a missing backup API before any cleanup, prompt, or process check`, async () => {
    const calls = [];
    await assert.rejects(entry({
      checkRuntime: () => loadSqlite({ version: '22.15.0',
        importSqlite: async () => ({ DatabaseSync: class {} }) }),
      checkClosed: async () => { calls.push('process check'); },
      runCleanup: async () => { calls.push('cleanup'); },
      repair: async () => { calls.push('catalog'); },
      ask: async () => { calls.push('prompt'); }, log: () => {},
    }), error => {
      assert.match(error.message, /Node\.js 22\.15\.0/);
      assert.match(error.message, /22\.16/);
      assert.match(error.message, /SQLite/);
      return true;
    });
    assert.deepEqual(calls, []);
  });
}

test('an unavailable SQLite module produces an actionable runtime error with its original cause', async () => {
  const cause = new Error('No such built-in module: node:sqlite');
  await assert.rejects(loadSqlite({ version: '20.0.0', importSqlite: async () => { throw cause; } }), error => {
    assert.match(error.message, /Node\.js 20\.0\.0/);
    assert.match(error.message, /24 이상/);
    assert.equal(error.cause, cause);
    return true;
  });
});
