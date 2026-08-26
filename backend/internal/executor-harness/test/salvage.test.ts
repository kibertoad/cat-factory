import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifySalvagePath,
  foldSalvageReports,
  salvageCommitMessage,
  salvageOnlyNotice,
  salvageUntrackedWork,
  describeSalvage,
  withSalvageOnlyNote,
  type SalvageOccasion,
  type SalvageReport,
} from '../src/salvage.js'
import { commitPaths, headCommit } from '../src/git.js'
import type { Logger } from '../src/logger.js'

const exec = promisify(execFile)

const SETTLED: SalvageOccasion = { kind: 'settled' }
const ABORTED: SalvageOccasion = { kind: 'aborted', cause: 'no progress' }

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
}

describe('classifySalvagePath (the deny-list)', () => {
  it('keeps the agent’s own source, at any depth', () => {
    for (const path of [
      'src/app.ts',
      'deploy/k8s/deployment.yaml',
      '.github/workflows/ci.yml',
      'eslint.config.js',
      'scripts/check-manifests.ts',
    ]) {
      expect(classifySalvagePath(path)).toBe('salvage')
    }
  })

  it('drops dependency trees, build output, logs and the harness sentinels', () => {
    for (const path of [
      'node_modules/left-pad/index.js',
      'packages/api/node_modules/x/y.js',
      'dist/app.js',
      'build/out.js',
      'coverage/lcov.info',
      '.venv/pyvenv.cfg',
      'src/__pycache__/mod.pyc',
      'target/debug/app',
      'vendor/github.com/x/y.go',
      'server.log',
      '.cat-effort.json',
      'services/api/.cat-pr-description.md',
    ]) {
      expect(classifySalvagePath(path)).toBe('skip')
    }
  })

  it('withholds credential-bearing files as SECRETS, not as junk', () => {
    // The distinction is the point: a `skip` is expected and silent, a `secret` is reported so a
    // live credential can be rotated. Both stay out of the commit.
    for (const path of [
      '.env',
      '.env.local',
      'services/api/.env.production',
      'id_rsa',
      'deploy/tls.key',
      'certs/server.pem',
      'keystore.p12',
      '.npmrc',
      '.netrc',
      'config/secrets.yaml',
      '.ssh/config',
      '.aws/credentials',
      'infra/.terraform/terraform.tfstate',
      'prod.env',
    ]) {
      expect(classifySalvagePath(path)).toBe('secret')
    }
  })

  it('keeps the .env SAMPLE files, which are the deliverable rather than a credential', () => {
    for (const path of ['.env.example', '.env.sample', 'services/api/.env.template']) {
      expect(classifySalvagePath(path)).toBe('salvage')
    }
  })
})

describe('salvageCommitMessage', () => {
  it('says an aborted run is what left the files, and that nobody reviewed them', () => {
    const message = salvageCommitMessage(3, {
      kind: 'aborted',
      cause: 'no progress: 40 tool calls',
    })
    expect(message).toMatch(/^chore: salvage 3 uncommitted files from an aborted agent run/)
    expect(message).toContain('no progress: 40 tool calls')
    expect(message).toMatch(/NOT a reviewed change/)
  })

  it('does not call a settled run aborted', () => {
    const message = salvageCommitMessage(1, { kind: 'settled' })
    expect(message).toMatch(/^chore: commit 1 new file the agent left untracked/)
    expect(message).not.toMatch(/abort/i)
  })
})

describe('withSalvageOnlyNote', () => {
  it('puts the notice above the briefing, and touches nothing else', () => {
    const pr = { title: 'Add the thing', body: '## Summary\n\nIt adds the thing.' }
    const marked = withSalvageOnlyNote(pr, true)
    expect(marked.body.startsWith(salvageOnlyNotice())).toBe(true)
    expect(marked.body).toContain(pr.body)
    // The TITLE is deliberately untouched: it follows the PR into every list and notification a
    // maintainer sees, which is a lot of noise for a caveat that belongs beside the diff.
    expect(marked.title).toBe(pr.title)
  })

  it('is byte-for-byte the input when the branch carries the agent’s own work', () => {
    const pr = { title: 'Add the thing', body: 'It adds the thing.' }
    expect(withSalvageOnlyNote(pr, false)).toEqual(pr)
  })
})

describe('salvageOnlyNotice', () => {
  it('tells a reviewer, before the diff, that nobody proposed this branch', () => {
    const notice = salvageOnlyNotice()
    // A blockquote, so it renders as a banner above the briefing rather than as its first
    // paragraph. The three facts a reviewer of such a PR is otherwise missing entirely.
    expect(notice.startsWith('> ')).toBe(true)
    expect(notice).toMatch(/committed nothing to this repository/)
    expect(notice).toMatch(/Nothing has reviewed them/)
    expect(notice).toMatch(/sibling repository/)
  })
})

describe('foldSalvageReports', () => {
  const report = (over: Partial<SalvageReport>): SalvageReport => ({
    status: 'none',
    files: [],
    fileCount: 0,
    totalBytes: 0,
    ...over,
  })
  const committed = (fileCount: number, sha: string, files: string[] = []): SalvageReport =>
    report({ status: 'committed', fileCount, totalBytes: fileCount * 10, commitSha: sha, files })

  it('folds a `none` pass away in either direction, which is the ordinary run', () => {
    const only = committed(3, 'aaa')
    expect(foldSalvageReports(only, report({}))).toEqual(only)
    expect(foldSalvageReports(report({}), only)).toEqual(only)
  })

  it('sums two COMMITTED passes, whose file sets are disjoint by construction', () => {
    // The first pass committed its files, so the second cannot see them again, only a repair
    // round's NEW files. Summing is the only reading that describes the branch.
    const folded = foldSalvageReports(committed(3, 'aaa', ['a.ts']), committed(2, 'bbb', ['b.ts']))
    expect(folded.status).toBe('committed')
    expect(folded.fileCount).toBe(5)
    expect(folded.totalBytes).toBe(50)
    expect(folded.files).toEqual(['a.ts', 'b.ts'])
    // The LAST commit that landed: the caller is about to push the branch carrying both.
    expect(folded.commitSha).toBe('bbb')
  })

  it('never sums a REFUSED pass, which sees the same files again on the next one', () => {
    const refused = report({ status: 'refused', fileCount: 400, reason: 'over the bounds' })
    const folded = foldSalvageReports(refused, refused)
    expect(folded.fileCount).toBe(400)
    expect(folded.reason).toMatch(/over the bounds/)
  })

  it('keeps the pass that could NOT keep its files over one that merely committed', () => {
    const failed = report({ status: 'failed', fileCount: 2, reason: 'the commit failed' })
    expect(foldSalvageReports(committed(3, 'aaa'), failed).status).toBe('failed')
    expect(foldSalvageReports(failed, committed(3, 'aaa')).status).toBe('failed')
    // …and `failed` outranks `refused`, which outranks `committed`.
    const refused = report({ status: 'refused', fileCount: 400 })
    expect(foldSalvageReports(refused, failed).status).toBe('failed')
    expect(foldSalvageReports(refused, committed(1, 'aaa')).status).toBe('refused')
  })

  it('names every withheld credential, whichever pass declined it and whichever status won', () => {
    // Naming the file is what lets someone rotate what it held, so it survives the fold whatever
    // else it loses, including onto a pass that had nothing of its own to say.
    const first = report({ status: 'none', withheld: ['.env'] })
    const second = committed(1, 'aaa')
    second.withheld = ['deploy/id_rsa', '.env']
    const folded = foldSalvageReports(first, second)
    expect(folded.status).toBe('committed')
    expect(folded.withheld).toEqual(['deploy/id_rsa', '.env'])
  })
})

describe('salvageUntrackedWork (against a real repository)', () => {
  let dir: string
  const git = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })
  const status = async (): Promise<string> =>
    String(await exec('git', ['status', '--porcelain'], { cwd: dir }).then((r) => r.stdout))

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'salvage-test-'))
    await git('init', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    await writeFile(join(dir, 'README.md'), '# base\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'base')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('commits the new files the agent left behind, and nothing on the deny-list', async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(join(dir, 'src', 'app.ts'), 'export const app = 1\n', 'utf8')
    await writeFile(join(dir, 'Dockerfile'), 'FROM node:22\n', 'utf8')
    await writeFile(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    await writeFile(join(dir, 'debug.log'), 'noise\n', 'utf8')
    await writeFile(join(dir, '.cat-effort.json'), '{}\n', 'utf8')

    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'aborted', cause: 'no progress' },
      logger: silentLogger,
    })

    expect(report.status).toBe('committed')
    expect(report.fileCount).toBe(2)
    expect(report.files.sort()).toEqual(['Dockerfile', 'src/app.ts'])
    expect(report.commitSha).toBe(await headCommit(dir))

    const tracked = String(
      await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir }).then(
        (r) => r.stdout,
      ),
    )
    expect(tracked).toContain('src/app.ts')
    expect(tracked).toContain('Dockerfile')
    expect(tracked).not.toContain('node_modules')
    expect(tracked).not.toContain('debug.log')
    expect(tracked).not.toContain('.cat-effort.json')
    // The denied paths are still there, untracked, exactly as the agent left them.
    expect(await status()).toMatch(/\?\? debug\.log/)
  })

  it('never salvages a gitignored path, whatever the deny-list says', async () => {
    // `scratch.txt` is a name every deny-list here ALLOWS, so git's own exclusion is the only
    // thing keeping it out — which is exactly the rule under test.
    await writeFile(join(dir, '.gitignore'), 'scratch.txt\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'ignore scratch')
    await writeFile(join(dir, 'scratch.txt'), 'notes\n', 'utf8')
    await writeFile(join(dir, 'src.ts'), 'export const x = 1\n', 'utf8')

    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'settled' },
      logger: silentLogger,
    })
    expect(report.files).toEqual(['src.ts'])
    expect(report.withheld).toBeUndefined()
    const tracked = String(
      await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir }).then(
        (r) => r.stdout,
      ),
    )
    expect(tracked).not.toContain('scratch.txt')
  })

  it('refuses an over-bound salvage entirely rather than truncating it', async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(dir, `file-${i}.ts`), 'export const x = 1\n', 'utf8')
    }
    const before = await headCommit(dir)

    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'aborted', cause: 'no progress' },
      logger: silentLogger,
      bounds: { maxFiles: 3, maxBytes: 1_000_000 },
    })

    expect(report.status).toBe('refused')
    expect(report.fileCount).toBe(5)
    expect(report.reason).toMatch(/exceed the salvage bounds/)
    expect(await headCommit(dir)).toBe(before)
    // Nothing was committed: a partial salvage would read as a complete change.
    expect(await status()).toMatch(/\?\? file-0\.ts/)
    expect(describeSalvage(report, SETTLED)).toMatch(/NOT salvaged/)
  })

  it('refuses on the BYTE bound too, with the file count well inside its own', async () => {
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(4096), 'utf8')
    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'settled' },
      logger: silentLogger,
      bounds: { maxFiles: 100, maxBytes: 1024 },
    })
    expect(report.status).toBe('refused')
    expect(report.totalBytes).toBeGreaterThan(1024)
  })

  it('salvages a file whose name git would C-QUOTE, and sizes it honestly', async () => {
    // `git ls-files` renders a non-ASCII path as the literal `"caf\303\251.ts"`, quotes and octal
    // escapes included. That string is not a filename: `git add` exits 128 on it, which discarded
    // the WHOLE all-or-nothing salvage, and `stat` on it failed, so it also weighed zero against
    // the byte bound. The listing is `-z` now, so the path is the real one.
    await writeFile(join(dir, 'café.ts'), 'export const x = 1\n', 'utf8')
    await writeFile(join(dir, 'plain.ts'), 'export const y = 2\n', 'utf8')

    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'settled' },
      logger: silentLogger,
    })

    expect(report.status).toBe('committed')
    expect(report.files.sort()).toEqual(['café.ts', 'plain.ts'])
    expect(report.totalBytes).toBeGreaterThan(0)
    const tracked = String(
      await exec('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { cwd: dir }).then(
        (r) => r.stdout,
      ),
    )
    expect(tracked.split('\0')).toContain('café.ts')
    expect(await status()).toBe('')
  })

  it('salvages a file whose name is pathspec MAGIC, rather than failing the whole salvage', async () => {
    // Everything after `--` is a pathspec, so a leading `:` is magic and `git add -- :notes.txt`
    // exits 128 with "did not match any files". One such name would take the other files with it.
    await writeFile(join(dir, ':notes.txt'), 'jotting\n', 'utf8')
    await writeFile(join(dir, 'src.ts'), 'export const x = 1\n', 'utf8')

    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'settled' },
      logger: silentLogger,
    })

    expect(report.status).toBe('committed')
    expect(report.files.sort()).toEqual([':notes.txt', 'src.ts'])
    expect(await status()).toBe('')
  })

  it('withholds a credential-bearing file, keeps the rest, and NAMES what it withheld', async () => {
    // The greenfield case this exists for: the agent was killed before it wrote a `.gitignore`,
    // so git excludes nothing and the harness is all that stands between a key and the PR.
    await writeFile(join(dir, '.env'), 'API_KEY=live-secret\n', 'utf8')
    await writeFile(join(dir, '.env.example'), 'API_KEY=\n', 'utf8')
    await writeFile(join(dir, 'id_rsa'), 'PRIVATE KEY\n', 'utf8')
    await writeFile(join(dir, 'src.ts'), 'export const x = 1\n', 'utf8')

    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'settled' },
      logger: silentLogger,
    })

    expect(report.status).toBe('committed')
    expect(report.files.sort()).toEqual(['.env.example', 'src.ts'])
    expect(report.withheld?.sort()).toEqual(['.env', 'id_rsa'])
    const tracked = String(
      await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir }).then(
        (r) => r.stdout,
      ),
    )
    expect(tracked).not.toContain('id_rsa')
    expect(tracked.split('\n')).not.toContain('.env')
    // Withholding is a decision someone has to know about, so it is stated and the paths named.
    const note = describeSalvage(report, SETTLED)
    expect(note).toMatch(/withheld from the salvage/)
    expect(note).toContain('.env')
    expect(note).toContain('id_rsa')
    expect(note).toMatch(/rotate/)
  })

  it('reports a withheld secret even when there was nothing else to salvage', async () => {
    // `none` is the status a clean run reports, so a withheld credential must not vanish with it.
    await writeFile(join(dir, '.env'), 'API_KEY=live-secret\n', 'utf8')
    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'settled' },
      logger: silentLogger,
    })
    expect(report.status).toBe('none')
    expect(report.withheld).toEqual(['.env'])
    expect(describeSalvage(report, SETTLED)).toMatch(/withheld from the salvage/)
  })

  it('says a salvage commit that was not pushed is LOST, never names it as delivered', async () => {
    await writeFile(join(dir, 'src.ts'), 'export const x = 1\n', 'utf8')
    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'aborted', cause: 'no progress' },
      logger: silentLogger,
    })
    expect(report.status).toBe('committed')

    expect(describeSalvage(report, ABORTED, { pushed: true })).not.toMatch(
      /lost with the container/,
    )
    const failed = describeSalvage(report, ABORTED, { pushed: false, reason: 'remote hung up' })
    expect(failed).toMatch(/could NOT be pushed/)
    expect(failed).toMatch(/remote hung up/)
    expect(failed).toMatch(/lost with the container/)
  })

  it('says an ABORTED run was aborted and a SETTLED one merely never committed', async () => {
    // The commit message has always taken the occasion; the note beside it hardcoded the aborted
    // reading, so a clean run that simply forgot to `git add` was told its run had been killed.
    await writeFile(join(dir, 'src.ts'), 'export const x = 1\n', 'utf8')
    const report = await salvageUntrackedWork({ dir, occasion: SETTLED, logger: silentLogger })
    expect(report.status).toBe('committed')

    const settled = describeSalvage(report, SETTLED)
    expect(settled).toMatch(/finished without committing them/)
    expect(settled).not.toMatch(/aborted/)
    expect(describeSalvage(report, ABORTED)).toMatch(/this run was aborted/)
    // Both still tell a reader the files carry nobody's judgement.
    expect(settled).toMatch(/review them before trusting them/)
  })

  it('commits ONLY the paths it was given, leaving an index the agent left populated', async () => {
    // An agent killed mid-flight can leave its own `git add` staged. A bare `git commit` would
    // sweep that content into the salvage commit, under a message naming only the untracked
    // files and counted by a report that never saw it.
    await writeFile(join(dir, 'README.md'), '# edited by the agent\n', 'utf8')
    await git('add', 'README.md')
    await writeFile(join(dir, 'new.ts'), 'export const y = 2\n', 'utf8')

    const report = await salvageUntrackedWork({ dir, occasion: ABORTED, logger: silentLogger })
    expect(report.status).toBe('committed')
    expect(report.fileCount).toBe(1)

    const committed = String(
      await exec('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir }).then(
        (r) => r.stdout,
      ),
    ).trim()
    expect(committed).toBe('new.ts')
    // The agent's staged edit is untouched and still staged, for whoever commits it next.
    expect(await status()).toMatch(/^M  README\.md$/m)
  })

  it('returns null rather than committing when only OTHER paths are staged', async () => {
    // The staged-anything check is scoped too: a populated index for paths this call did not name
    // is not "there is something to commit here". Unscoped, this would commit the agent's staged
    // README edit under the message below and report a sha for a salvage that salvaged nothing.
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src/keep.ts'), 'export const k = 1\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'the agent’s own commit')
    await writeFile(join(dir, 'README.md'), '# edited\n', 'utf8')
    await git('add', 'README.md')
    const before = await headCommit(dir)

    // `src/keep.ts` is tracked and unchanged, so this call has nothing of its OWN to commit.
    expect(await commitPaths(dir, ['src/keep.ts'], 'should not land')).toBeNull()
    expect(await headCommit(dir)).toBe(before)
    expect(await status()).toMatch(/^M  README\.md$/m)
  })

  it('reports nothing to do when the agent committed everything', async () => {
    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'settled' },
      logger: silentLogger,
    })
    expect(report.status).toBe('none')
    expect(describeSalvage(report, SETTLED)).toBeUndefined()
  })
})

describe('coding mode only', () => {
  // A read-only kind (merger, blueprinter, the explore paths) has no work branch to carry a
  // commit and must never be given one. There is no runtime flag to assert that against: what
  // makes it true is WHICH modules can reach the COMMITTING entry point at all, so assert that,
  // derived from the sources rather than restated as a number.
  //
  // The module's other exports are pure text (`salvageOnlyNotice` and the `withSalvageOnlyNote`
  // that places it, `describeSalvage`, `salvageCommitMessage`) and commit nothing, which is why
  // the two assertions below are separate: `agent.ts` legitimately reaches the second set to mark
  // a salvage-only pull request, and must not thereby be granted the first.
  const importersOf = async (needle: string): Promise<string[]> => {
    const srcDir = new URL('../src/', import.meta.url)
    const files = (await readdir(srcDir)).filter((name) => name.endsWith('.ts'))
    const importers: string[] = []
    for (const name of files) {
      const body = await readFile(new URL(name, srcDir), 'utf8')
      const imports = /import\s*\{([^}]*)\}\s*from '\.\/salvage\.js'/.exec(body)?.[1]
      if (imports?.includes(needle)) importers.push(name)
    }
    return importers.sort()
  }

  it('can be COMMITTED only from the coding paths', async () => {
    expect(await importersOf('salvageUntrackedWork')).toEqual([
      'coding-agent.ts',
      'multi-repo-coding.ts',
    ])
  })

  it('lets the PR-opening paths reach the notice, which writes nothing', async () => {
    expect(await importersOf('withSalvageOnlyNote')).toEqual(['agent.ts', 'multi-repo-coding.ts'])
  })
})
