import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifySalvagePath,
  salvageCommitMessage,
  salvageOnlyNotice,
  salvageUntrackedWork,
  describeSalvage,
} from '../src/salvage.js'
import { headCommit } from '../src/git.js'
import type { Logger } from '../src/logger.js'

const exec = promisify(execFile)

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
    expect(describeSalvage(report)).toMatch(/NOT salvaged/)
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
    const note = describeSalvage(report)
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
    expect(describeSalvage(report)).toMatch(/withheld from the salvage/)
  })

  it('says a salvage commit that was not pushed is LOST, never names it as delivered', async () => {
    await writeFile(join(dir, 'src.ts'), 'export const x = 1\n', 'utf8')
    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'aborted', cause: 'no progress' },
      logger: silentLogger,
    })
    expect(report.status).toBe('committed')

    expect(describeSalvage(report, { pushed: true })).not.toMatch(/lost with the container/)
    const failed = describeSalvage(report, { pushed: false, reason: 'remote hung up' })
    expect(failed).toMatch(/could NOT be pushed/)
    expect(failed).toMatch(/remote hung up/)
    expect(failed).toMatch(/lost with the container/)
  })

  it('reports nothing to do when the agent committed everything', async () => {
    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'settled' },
      logger: silentLogger,
    })
    expect(report.status).toBe('none')
    expect(describeSalvage(report)).toBeUndefined()
  })
})

describe('coding mode only', () => {
  // A read-only kind (merger, blueprinter, the explore paths) has no work branch to carry a
  // commit and must never be given one. There is no runtime flag to assert that against: what
  // makes it true is WHICH modules can reach the salvage at all, so assert that, derived from
  // the sources rather than restated as a number.
  it('is reachable only from the coding paths', async () => {
    const srcDir = new URL('../src/', import.meta.url)
    const files = (await readdir(srcDir)).filter((name) => name.endsWith('.ts'))
    const importers: string[] = []
    for (const name of files) {
      const body = await readFile(new URL(name, srcDir), 'utf8')
      if (body.includes("from './salvage.js'")) importers.push(name)
    }
    expect(importers.sort()).toEqual(['coding-agent.ts', 'multi-repo-coding.ts'])
  })
})
