import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type CliOptions } from './args.js'
import { bootstrap } from './bootstrap.js'
import { type FileSystem } from './fs.js'
import { type Io } from './io.js'

/** In-memory filesystem for asserting what the bootstrap writes. */
function memFs(seed: Record<string, string> = {}): FileSystem & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
    readFileSync: (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
    writeFileSync: (p, d) => {
      files.set(p, d)
    },
  }
}

/** Scripted Io: answers/secrets/selects come from queues; openBrowser is recorded. */
function scriptIo(
  answers: string[] = [],
  secrets: string[] = [],
  confirms: boolean[] = [],
  selects: string[] = [],
): Io & {
  opened: string[]
} {
  const a = [...answers]
  const s = [...secrets]
  const c = [...confirms]
  const sel = [...selects]
  const opened: string[] = []
  return {
    opened,
    info: () => {},
    warn: () => {},
    question: (_p, d) => Promise.resolve(a.shift() ?? d ?? ''),
    select: <T extends string>(_p: string, _o: readonly { value: T }[], d: T) =>
      Promise.resolve((sel.shift() as T | undefined) ?? d),
    secret: () => Promise.resolve(s.shift() ?? ''),
    confirm: (_p, d) => Promise.resolve(c.shift() ?? d),
    openBrowser: (url) => {
      opened.push(url)
      return Promise.resolve()
    },
  }
}

const fixedBytes = (size: number) => Buffer.alloc(size, 1)

function opts(extra: Partial<CliOptions>): CliOptions {
  return { command: 'init', noOpen: false, yes: false, force: false, ...extra }
}

describe('bootstrap (non-interactive)', () => {
  it('scaffolds a full project from flags with no prompting', async () => {
    const fs = memFs()
    const io = scriptIo()
    const dir = await bootstrap(
      opts({ yes: true, provider: 'github', token: 'ghp_flag', dir: 'out' }),
      { io, fs, cwd: '/work', randomBytes: fixedBytes },
    )
    expect(dir).toBe('/work/out')
    expect(fs.files.get('/work/out/local/.env')).toContain('GITHUB_PAT=ghp_flag')
    // Generated secrets are deterministic with the fixed RNG.
    expect(fs.files.get('/work/out/local/.env')).toContain(`AUTH_SESSION_SECRET=${'01'.repeat(32)}`)
    expect(fs.files.get('/work/out/local/.env')).toContain(
      `HARNESS_SHARED_SECRET=${'01'.repeat(32)}`,
    )
    expect(fs.files.get('/work/out/frontend/.env')).toContain(
      'NUXT_PUBLIC_API_BASE=http://localhost:8787',
    )
    expect(fs.files.get('/work/out/.gitignore')).toContain('!.env.example')
    // No browser opened, no prompts in --yes mode.
    expect(io.opened).toEqual([])
  })

  it('derives the SPA api-base from a non-default --port', async () => {
    const fs = memFs()
    await bootstrap(opts({ yes: true, token: 't', dir: 'out', port: 9000 }), {
      io: scriptIo(),
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    expect(fs.files.get('/work/out/frontend/.env')).toContain(
      'NUXT_PUBLIC_API_BASE=http://localhost:9000',
    )
    expect(fs.files.get('/work/out/local/.env')).toContain('PORT=9000')
  })

  it('slugifies a free-text project name for the npm package names and dir', async () => {
    const fs = memFs()
    const dir = await bootstrap(opts({ yes: true, token: 't', projectName: 'My Cats' }), {
      io: scriptIo(),
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    expect(dir).toBe('/work/my-cats')
    expect(fs.files.get('/work/my-cats/local/package.json')).toContain('"name": "my-cats-local"')
  })

  it('threads --container-runtime into the env', async () => {
    const fs = memFs()
    await bootstrap(opts({ yes: true, token: 't', dir: 'out', containerRuntime: 'podman' }), {
      io: scriptIo(),
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    expect(fs.files.get('/work/out/local/.env')).toContain('LOCAL_CONTAINER_RUNTIME=podman')
  })

  it('threads native execution flags into the env', async () => {
    const fs = memFs()
    await bootstrap(
      opts({
        yes: true,
        token: 't',
        dir: 'out',
        executionMode: 'native',
        nativeHarnesses: ['codex'],
        harnessEntry: '/opt/harness/server.js',
      }),
      { io: scriptIo(), fs, cwd: '/work', randomBytes: fixedBytes },
    )
    const env = fs.files.get('/work/out/local/.env') ?? ''
    expect(env).toMatch(/^LOCAL_NATIVE_AGENTS=codex$/m)
    expect(env).toMatch(/^LOCAL_HARNESS_ENTRY=\/opt\/harness\/server\.js$/m)
  })
})

describe('bootstrap (interactive PAT flow)', () => {
  it('opens the browser at the pre-scoped URL and writes the pasted token', async () => {
    const fs = memFs()
    // question order: project name, app title, db url, api base; select: provider, runtime;
    // confirm: open browser; secret: token.
    const io = scriptIo(
      [
        'my-cats',
        'My Cats',
        'postgres://cat:cat@localhost:5432/catfactory',
        'http://localhost:8787',
      ],
      ['ghp_pasted'],
      [true],
      ['github', 'docker'],
    )
    await bootstrap(opts({}), { io, fs, cwd: '/work', randomBytes: fixedBytes })
    expect(io.opened).toHaveLength(1)
    expect(io.opened[0]).toContain('github.com/settings/tokens/new')
    expect(io.opened[0]).toContain('scopes=repo%2Cworkflow')
    expect(fs.files.get('/work/my-cats/local/.env')).toContain('GITHUB_PAT=ghp_pasted')
  })

  it('drives the interactive native-mode flow (mode + harness + entry)', async () => {
    const fs = memFs()
    // questions: name, title, db, api-base, harness entry
    // selects: provider, runtime, execution-mode, native-harnesses
    // confirms: show-models, open-browser, generate-secrets
    const io = scriptIo(
      [
        'my-cats',
        'My Cats',
        'postgres://cat:cat@localhost:5432/catfactory',
        'http://localhost:8787',
        '/srv/harness/server.js',
      ],
      ['ghp_pasted'],
      [true, true, true],
      ['github', 'docker', 'native', 'both'],
    )
    await bootstrap(opts({}), { io, fs, cwd: '/work', randomBytes: fixedBytes })
    const env = fs.files.get('/work/my-cats/local/.env') ?? ''
    expect(env).toMatch(/^LOCAL_NATIVE_AGENTS=claude-code,codex$/m)
    expect(env).toMatch(/^LOCAL_HARNESS_ENTRY=\/srv\/harness\/server\.js$/m)
  })

  it('leaves the secrets blank when the developer declines generation', async () => {
    const fs = memFs()
    const warn = vi.fn()
    // Non-interactive-ish: options pre-set everything except the generate-secrets confirm.
    const io = scriptIo([], [], [false])
    io.warn = warn
    await bootstrap(opts({ provider: 'github', token: 't', dir: 'out', executionMode: 'pool' }), {
      io,
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    const env = fs.files.get('/work/out/local/.env') ?? ''
    expect(env).toMatch(/^AUTH_SESSION_SECRET=$/m)
    expect(env).toMatch(/^ENCRYPTION_KEY=$/m)
    expect(env).toMatch(/^HARNESS_SHARED_SECRET=$/m)
    expect(warn).toHaveBeenCalled()
  })

  it('does not open the browser with --no-open', async () => {
    const fs = memFs()
    const io = scriptIo(
      ['p', 't', 'postgres://cat:cat@localhost:5432/catfactory', 'http://localhost:8787'],
      ['glpat-x'],
      [],
      ['gitlab', 'docker'],
    )
    await bootstrap(opts({ noOpen: true }), { io, fs, cwd: '/w', randomBytes: fixedBytes })
    expect(io.opened).toEqual([])
    expect(fs.files.get('/w/p/local/.env')).toContain('GITLAB_PAT=glpat-x')
  })
})

describe('bootstrap (existing files)', () => {
  it('skips existing files without --force but always merges .gitignore', async () => {
    const fs = memFs({
      '/w/p/local/package.json': '{"existing":true}',
      '/w/p/.gitignore': 'custom-rule/\n',
    })
    const io = scriptIo()
    const warn = vi.fn()
    io.warn = warn
    await bootstrap(opts({ yes: true, token: 't', dir: 'p' }), {
      io,
      fs,
      cwd: '/w',
      randomBytes: fixedBytes,
    })
    // Existing package.json untouched.
    expect(fs.files.get('/w/p/local/package.json')).toBe('{"existing":true}')
    // .gitignore merged, not replaced.
    expect(fs.files.get('/w/p/.gitignore')).toContain('custom-rule/')
    expect(fs.files.get('/w/p/.gitignore')).toContain('.env')
    expect(warn).toHaveBeenCalled()
  })

  it('overwrites with --force', async () => {
    const fs = memFs({ '/w/p/local/package.json': '{"existing":true}' })
    await bootstrap(opts({ yes: true, token: 't', dir: 'p', force: true }), {
      io: scriptIo(),
      fs,
      cwd: '/w',
      randomBytes: fixedBytes,
    })
    expect(fs.files.get('/w/p/local/package.json')).not.toBe('{"existing":true}')
  })
})

describe('bootstrap (git-init nudge)', () => {
  it('nudges `git init` for a fresh (non-git) target dir', async () => {
    const fs = memFs()
    const io = scriptIo()
    const lines: string[] = []
    io.info = (m) => {
      lines.push(m)
    }
    await bootstrap(opts({ yes: true, token: 't', dir: 'out' }), {
      io,
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    expect(lines.join('\n')).toContain('git init')
  })

  it('skips the nudge when the target is already a git repo', async () => {
    const fs = memFs({ '/work/out/.git': '' })
    const io = scriptIo()
    const lines: string[] = []
    io.info = (m) => {
      lines.push(m)
    }
    await bootstrap(opts({ yes: true, token: 't', dir: 'out' }), {
      io,
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    expect(lines.join('\n')).not.toContain('git init')
  })
})

describe('bootstrap (Compose project identity)', () => {
  /** Found by suffix, so these assertions hold whatever the host's path separator is. */
  function writtenFile(files: Map<string, string>, suffix: string): string {
    return [...files].find(([path]) => path.split('\\').join('/').endsWith(suffix))?.[1] ?? ''
  }

  function composeProject(files: Map<string, string>): string {
    return /^name: (.+)$/m.exec(writtenFile(files, 'local/docker-compose.yml'))?.[1] ?? ''
  }

  async function scaffold(extra: Partial<CliOptions>, seed: Record<string, string> = {}) {
    const fs = memFs(seed)
    const io = scriptIo()
    const warns: string[] = []
    io.warn = (m) => {
      warns.push(m)
    }
    await bootstrap(opts({ yes: true, token: 't', ...extra }), {
      io,
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    return { files: fs.files, warns: warns.join('\n') }
  }

  it('gives two deployments two projects, though both take the default project name', async () => {
    const a = await scaffold({ dir: 'deploy-a' })
    const b = await scaffold({ dir: 'deploy-b' })
    // Same npm package name in both: the project name is a constant unless the user changes it,
    // which is why the Compose project cannot be derived from it.
    expect(writtenFile(a.files, 'local/package.json')).toContain('"name": "cat-factory-local"')
    expect(writtenFile(b.files, 'local/package.json')).toContain('"name": "cat-factory-local"')
    expect(composeProject(a.files)).toBe('deploy-a-local')
    expect(composeProject(b.files)).toBe('deploy-b-local')
    // `local` is the name Compose derives from the compose file's own directory in EVERY
    // deployment, so it is the one answer that shares a Postgres volume between them.
    expect([composeProject(a.files), composeProject(b.files)]).not.toContain('local')
  })

  it('names the Compose project a regenerate leaves behind', async () => {
    const composePath = join(resolve('/work', 'deploy-a'), 'local', 'docker-compose.yml')
    // A deployment scaffolded before the name was declared: Compose ran it as project `local`.
    const { warns } = await scaffold(
      { dir: 'deploy-a', force: true },
      {
        [composePath]: 'services:\n  postgres:\n    image: postgres:18\n',
      },
    )
    expect(warns).toContain('Compose project "local"')
    expect(warns).toContain('local_cat-factory-pg')
    expect(warns).toContain('docker compose -p local down')
  })

  it('says nothing when no project is left behind', async () => {
    const composePath = join(resolve('/work', 'deploy-a'), 'local', 'docker-compose.yml')
    const fresh = await scaffold({ dir: 'deploy-a', force: true })
    expect(fresh.warns).not.toContain('docker compose -p')
    // Without --force the existing compose file is skipped, so its project does not move.
    const skipped = await scaffold({ dir: 'deploy-a' }, { [composePath]: 'services:\n' })
    expect(skipped.warns).not.toContain('docker compose -p')
    // Nor does rerunning the same deployment.
    const rerun = await scaffold(
      { dir: 'deploy-a', force: true },
      {
        [composePath]: 'name: deploy-a-local\nservices:\n',
      },
    )
    expect(rerun.warns).not.toContain('docker compose -p')
  })
})
