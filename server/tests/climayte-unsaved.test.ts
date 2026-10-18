// server/tests/climayte-unsaved.test.ts — which of a worker's changed files a passing check still finds
// uncommitted (climayte-unsaved.ts), in a real temporary git repository.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type FileEdits,
  failsOnlyOnOthersFiles,
  outputPaths,
  parseEdits,
  saysNoCommit,
  uncommittedOf,
} from '../src/climayte-unsaved'

const root = mkdtempSync(join(tmpdir(), 'ah-climayte-unsaved-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  spawnSync(
    'git',
    ['-c', 'user.name=Example Owner', '-c', 'user.email=owner@example.com', ...args],
    { cwd, encoding: 'utf8' },
  )

const toolLine = (name: string, input: Record<string, unknown>, at: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] },
  })

const edit = (at: number, wrote: string[] = [], old: string[] = []): FileEdits => ({
  at,
  wrote: new Set(wrote),
  old: new Set(old),
  capped: false,
})

/** A repository under `root` with `files` (repo-relative) committed as its first commit. */
function repoWith(name: string, files: Record<string, string>): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  return dir
}

describe('parseEdits', () => {
  test('names what Edit, Write, MultiEdit and NotebookEdit changed, never what Read opened', () => {
    const at = '2020-10-05T12:00:00.000Z'
    const later = '2020-10-05T12:05:00.000Z'
    const text = [
      '{"cut first line',
      toolLine('Read', { file_path: '/repo/read-only.ts' }, at),
      toolLine('Write', { file_path: '/repo/new.ts', content: 'x' }, at),
      toolLine('Edit', { file_path: 'src/rel.ts', old_string: 'a', new_string: 'b' }, at),
      toolLine('MultiEdit', { file_path: '/repo/multi.ts', edits: [] }, at),
      toolLine('NotebookEdit', { notebook_path: '/repo/book.ipynb' }, at),
      toolLine('Edit', { file_path: '/repo/new.ts', old_string: 'x', new_string: 'y' }, later),
    ].join('\n')
    const got = parseEdits(text, join(root, 'base'))
    expect([...got.keys()].map((p) => p.replaceAll('\\', '/'))).toEqual([
      expect.stringMatching(/\/repo\/new\.ts$/),
      `${join(root, 'base', 'src', 'rel.ts').replaceAll('\\', '/')}`,
      expect.stringMatching(/\/repo\/multi\.ts$/),
      expect.stringMatching(/\/repo\/book\.ipynb$/),
    ])
    // The newest write to a file is the one kept.
    expect([...got.values()][0]?.at).toBe(Date.parse(later))
  })

  test('keeps the usable lines a worker wrote or replaced, per file', () => {
    const at = '2020-10-05T12:00:00.000Z'
    const multi = join(root, 'multi.ts')
    const book = join(root, 'book.ipynb')
    const text = [
      toolLine(
        'MultiEdit',
        {
          file_path: multi,
          edits: [
            { old_string: 'const oldOne = 1', new_string: 'const newOne = 2' },
            { old_string: '}', new_string: '});' },
          ],
        },
        at,
      ),
      toolLine('NotebookEdit', { notebook_path: book, new_source: 'print(hello)\n\n' }, at),
    ].join('\n')
    const got = parseEdits(text, root)
    expect([...(got.get(multi)?.wrote ?? [])]).toEqual(['const newOne = 2'])
    expect([...(got.get(multi)?.old ?? [])]).toEqual(['const oldOne = 1'])
    expect([...(got.get(book)?.wrote ?? [])]).toEqual(['print(hello)'])
  })
})

describe('uncommittedOf', () => {
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(repo, 'init', '-q')
  writeFileSync(join(repo, '.gitignore'), 'scratch.log\n')
  writeFileSync(join(repo, 'src', 'kept.ts'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'start')

  test('lists changed and untracked files the session wrote, not committed, ignored or peer-changed ones', async () => {
    const now = Date.now()
    writeFileSync(join(repo, 'src', 'kept.ts'), 'two\n') // tracked, changed
    mkdirSync(join(repo, 'src', 'fresh'), { recursive: true })
    writeFileSync(join(repo, 'src', 'fresh', 'new.ts'), 'new\n') // untracked, in an untracked folder
    writeFileSync(join(repo, 'saved.ts'), 'saved\n')
    git(repo, 'add', 'saved.ts')
    git(repo, 'commit', '-q', '-m', 'saved') // committed: clean
    writeFileSync(join(repo, 'scratch.log'), 'log\n') // ignored
    writeFileSync(join(repo, 'peer.ts'), 'peer\n') // changed by someone else after the session wrote it
    const peerTime = new Date(now + 120_000)
    utimesSync(join(repo, 'peer.ts'), peerTime, peerTime)
    writeFileSync(join(root, 'outside.ts'), 'elsewhere\n') // outside the repository

    const edits = new Map<string, FileEdits>(
      ['src/kept.ts', 'src/fresh/new.ts', 'saved.ts', 'scratch.log', 'peer.ts'].map((p) => [
        join(repo, p),
        edit(now),
      ]),
    )
    edits.set(join(root, 'outside.ts'), edit(now))
    expect(await uncommittedOf(join(repo, 'src'), edits)).toEqual([
      'src/fresh/new.ts',
      'src/kept.ts',
    ])
    // Four git commands, two here and two in uncommittedOf: each 0.5-3.4 s on a box at ~90% CPU
    // (2026-10-11), where bun's 5 s default ran out.
  }, 30_000)

  test('outside a repository there is nothing to hold it to', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'a.ts'), 'a\n')
    expect(await uncommittedOf(plain, new Map([[join(plain, 'a.ts'), edit(Date.now())]]))).toEqual(
      [],
    )
  })

  test("a shared file left with only another session's hunk is not this worker's", async () => {
    const dir = repoWith('peer-hunk', { 'src/shared.ts': 'export const base = 1\n' })
    const file = join(dir, 'src', 'shared.ts')
    writeFileSync(file, 'export const base = 1\nexport const first = 2\n')
    git(dir, 'add', 'src/shared.ts')
    git(dir, 'commit', '-q', '-m', 'the worker')
    writeFileSync(file, 'export const base = 1\nexport const first = 2\nexport const second = 4\n')
    const edits = new Map([[file, edit(Date.now(), ['export const first = 2'])]])
    expect(await uncommittedOf(dir, edits)).toEqual([])
  }, 30_000)

  test("a worker's own line still uncommitted in a file is its unsaved work", async () => {
    const dir = repoWith('own-line', { 'src/mine.ts': 'export const base = 1\n' })
    const file = join(dir, 'src', 'mine.ts')
    writeFileSync(file, 'export const base = 1\nexport const mine = 3\n')
    const edits = new Map([[file, edit(Date.now(), ['export const mine = 3'])]])
    expect(await uncommittedOf(dir, edits)).toEqual(['src/mine.ts'])
  }, 30_000)

  test('a line the worker only deleted and left uncommitted is its unsaved work', async () => {
    const dir = repoWith('deleted-line', {
      'src/legacy.ts': 'export const legacy = helper(alpha)\nexport const keep = 1\n',
    })
    const file = join(dir, 'src', 'legacy.ts')
    writeFileSync(file, 'export const keep = 1\n')
    const edits = new Map([[file, edit(Date.now(), [], ['export const legacy = helper(alpha)'])]])
    expect(await uncommittedOf(dir, edits)).toEqual(['src/legacy.ts'])
  }, 30_000)

  test('an untracked file the worker wrote is its unsaved work', async () => {
    const dir = repoWith('untracked', { 'README.md': 'readme text here\n' })
    const file = join(dir, 'src', 'fresh.ts')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'export const fresh = wrote(beta)\n')
    const edits = new Map([[file, edit(Date.now(), ['export const fresh = wrote(beta)'])]])
    expect(await uncommittedOf(dir, edits)).toEqual(['src/fresh.ts'])
  }, 30_000)

  test("trivial lines a worker wrote never tie it to another session's brace-only hunk", async () => {
    const dir = repoWith('braces', { 'src/c.ts': 'export const base = 0\n' })
    const file = join(dir, 'src', 'c.ts')
    writeFileSync(file, 'export const base = 0\n});\n}\n')
    const at = new Date().toISOString()
    const edits = parseEdits(
      toolLine(
        'Edit',
        {
          file_path: file,
          old_string: 'export const base = 0',
          new_string: 'export const base = 0\n});\n}',
        },
        at,
      ),
      dir,
    )
    expect(await uncommittedOf(dir, edits)).toEqual([])
  }, 30_000)

  test('a dirty file with no line sets is counted as before', async () => {
    const dir = repoWith('no-sets', { 'src/n.ts': 'export const base = 1\n' })
    const file = join(dir, 'src', 'n.ts')
    writeFileSync(file, 'export const base = 1\nexport const more = 5\n')
    expect(await uncommittedOf(dir, new Map([[file, edit(Date.now())]]))).toEqual(['src/n.ts'])
  }, 30_000)
})

describe('saysNoCommit', () => {
  test('commit decides; left out, the words of the prompt or the brief file it names do', async () => {
    const dir = join(root, 'briefs')
    mkdirSync(dir, { recursive: true })
    const brief = join(dir, 'R17-S.md').replaceAll('\\', '/')
    writeFileSync(
      brief,
      '# R17-S\n**Do NOT run git commit, git add or git push: leave every change uncommitted; the orchestrator lands it.**\n',
    )
    const rules = join(dir, 'CLAUDE.md').replaceAll('\\', '/')
    writeFileSync(rules, 'Do not commit until the gate is green.\n')
    // The rb-r17 builders' prompt, 2026-10-12, word for word but its path: one to no file, so its own
    // words decide.
    const rb17 = `Read and carry out the brief ${join(dir, 'gone', 'R17-S.md')} exactly. It names the files you own, the test to write first, and the check to pass. Do NOT run git commit, git add or git push. Report what the brief's Check section asks for.`
    const cases: Array<[string, string, boolean | undefined, boolean]> = [
      ['the rb-r17 prompt', rb17, undefined, true],
      ['a brief file that forbids committing', `Carry out the brief ${brief}.`, undefined, true],
      ['commit: false on a plain prompt', 'build the page', false, true],
      ['commit: true over no-commit words', 'draft it, do not commit it', true, false],
      ['a plain prompt', 'build the page and test it', undefined, false],
      [
        'a rule about what never to commit',
        'never commit secrets; build the page',
        undefined,
        false,
      ],
      [
        "the repository's own rules are no brief",
        `Follow the brief in ${rules}.`,
        undefined,
        false,
      ],
    ]
    for (const [name, prompt, commit, expected] of cases)
      expect([name, await saysNoCommit({ prompt, cwd: dir, commit })]).toEqual([name, expected])
  })
})

describe('failsOnlyOnOthersFiles', () => {
  const mine = ['C:/Work/Repo/src/Foo.vue', 'C:/Work/Repo/desk2/hydra/src/bar.ts']
  // Another session's uncommitted work in the same checkout, repo-relative as git prints it.
  const dirty = ['src/Peer.ts', 'src/NotFoo.vue', 'desk2/hydra/src/QuickApp.vue', 'src/Foo.vue']
  test("a failed check is not the task's only when it fails on another session's uncommitted files", () => {
    const cases: Array<[string, string, boolean]> = [
      ['its own file, repo-relative with a position', 'src/foo.vue(3,5): error TS2322', false],
      ['its own file, nested with a line', 'FAIL desk2/hydra/src/bar.ts:12', false],
      ['a file named by its basename', 'bar.ts:1:1 lint', false],
      ['one of its files among others', 'src/peer.ts:1 and src/foo.vue:2', false],
      ["only a peer's file", 'src/peer.ts(9,1): error', true],
      ['a backslash path of a peer', '.\\src\\peer.ts:4', true],
      ["a peer's file printed from a subfolder", 'src/QuickApp.vue(3,1): error TS2322', true],
      ['a path that only ends like its file', 'src/notfoo.vue:1', true],
      // The task's own change broke a test nobody else touched: that is the task's fail.
      ['an unchanged test its change broke', 'FAIL src/foo.test.ts > adds', false],
      ['no file named', 'Expected 3 received 4, e.g. v1.2 timed out', false],
    ]
    for (const [name, output, expected] of cases)
      expect([name, failsOnlyOnOthersFiles(output, mine, dirty)]).toEqual([name, expected])
  })

  test('outputPaths reads positions off and ignores version numbers', () => {
    expect(outputPaths('a/B.TS:3 x\\y.vue(1,2) v1.2 e.g')).toEqual(['a/b.ts', 'x/y.vue'])
  })
})
