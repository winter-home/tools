export async function loadSqlite({ importSqlite = () => import('node:sqlite'), version = process.versions.node } = {}) {
  try {
    const sqlite = await importSqlite();
    if (typeof sqlite.DatabaseSync !== 'function' || typeof sqlite.backup !== 'function') {
      throw new Error('node:sqlite requires DatabaseSync and backup');
    }
    return sqlite;
  } catch (cause) {
    throw new Error(`Node.js ${version}에서 필요한 SQLite 백업 기능을 사용할 수 없습니다. `
      + 'Node.js 22.16+ (22.x), 23.8+ (23.x), 또는 24 이상으로 실행해 주세요.', { cause });
  }
}
