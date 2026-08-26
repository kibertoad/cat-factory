import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isSalvageablePath,
  salvageCommitMessage,
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

describe('isSalvageablePath (the deny-list)', () => {
  it('keeps the agent’s own source, at any depth', () => {
    for (const path of [
      'src/app.ts',
      'deploy/k8s/deployment.yaml',
      '.github/workflows/ci.yml',
      'eslint.config.js',
      'scripts/check-manifests.ts',
    ]) {
      expect(isSalvageablePath(path)).toBe(true)
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
      expect(isSalvageablePath(path)).toBe(false)
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
    await writeFile(join(dir, '.gitignore'), 'secrets.env\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'ignore secrets')
    await writeFile(join(dir, 'secrets.env'), 'TOKEN=xyz\n', 'utf8')
    await writeFile(join(dir, 'src.ts'), 'export const x = 1\n', 'utf8')

    const report = await salvageUntrackedWork({
      dir,
      occasion: { kind: 'settled' },
      logger: silentLogger,
    })
    expect(report.files).toEqual(['src.ts'])
    const tracked = String(
      await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir }).then(
        (r) => r.stdout,
      ),
    )
    expect(tracked).not.toContain('secrets.env')
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
