import { describe, expect, it, vi } from 'vitest'
import { type CliOptions } from './args.js'
import { bootstrap, type FileSystem } from './bootstrap.js'
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
