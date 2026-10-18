// server/tests/hold-sqlite.ts — another process holding a SQLite file, for the tests that must prove the
// conversation index (server/src/search-index.ts) waits for a held file, or that a search never does.
import { expect } from 'bun:test'

/** A second process that opens the database at `path`, runs `sql` (the last statement takes the lock)
 *  and lets go `holdMs` later. Answers once the lock is held, with the child, for its exit code. */
export async function holdSqlite(path: string, holdMs: number, ...sql: string[]) {
  const holder = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { Database } = require('bun:sqlite')
const db = new Database(process.argv[1], { create: true })
db.exec('pragma busy_timeout = 2000')
db.exec('pragma journal_mode = delete')
db.exec('create table if not exists hold (x integer)')
for (const sql of process.argv.slice(3)) db.exec(sql)
console.log('locked')
setTimeout(() => { db.exec('commit'); db.close() }, Number(process.argv[2]))`,
      path,
      String(holdMs),
      ...sql,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const lines = holder.stdout.pipeThrough(new TextDecoderStream()).getReader()
  let seen = ''
  while (!seen.includes('locked')) {
    const { value, done } = await lines.read()
    if (done) break
    seen += value
  }
  // A child that dies before taking the lock says why on stderr, which is otherwise never read.
  if (!seen.includes('locked')) throw new Error(await new Response(holder.stderr).text())
  expect(seen).toContain('locked')
  return holder
}
