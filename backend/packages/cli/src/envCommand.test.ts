import { describe, expect, it, vi } from 'vitest'
import { type CliOptions } from './args.js'
import { EnvCommandError, generateEnv } from './envCommand.js'
import { type FileSystem } from './fs.js'
import { type Io } from './io.js'

/** In-memory filesystem for asserting what the command writes. */
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

/** Scripted Io: answers/secrets/confirms/selects come from queues; openBrowser is recorded. */
function scriptIo(
  answers: string[] = [],
  secrets: string[] = [],
  confirms: boolean[] = [],
  selects: string[] = [],
): Io & { opened: string[] } {
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
  return { command: 'env', noOpen: false, yes: false, force: false, ...extra }
}

describe('generateEnv (non-interactive)', () => {
  it('writes a single ready-to-run .env into the cwd with all three secrets', async () => {
    const fs = memFs()
    const io = scriptIo()
    const path = await generateEnv(opts({ yes: true, token: 'ghp_flag' }), {
      io,
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    expect(path).toBe('/work/.env')
    const env = fs.files.get('/work/.env') ?? ''
    expect(env).toContain('GITHUB_PAT=ghp_flag')
    expect(env).toContain(`AUTH_SESSION_SECRET=${'01'.repeat(32)}`)
    expect(env).toContain(`ENCRYPTION_KEY=${Buffer.alloc(32, 1).toString('base64')}`)
    expect(env).toContain(`HARNESS_SHARED_SECRET=${'01'.repeat(32)}`)
    expect(env).toContain('DATABASE_URL=postgres://cat:cat@localhost:5432/catfactory')
    // No project scaffold — just the env file and the .gitignore that protects it.
    expect([...fs.files.keys()].sort()).toEqual(['/work/.env', '/work/.gitignore'])
    // The secret file is guaranteed uncommittable.
    expect(fs.files.get('/work/.gitignore')).toContain('.env')
    expect(io.opened).toEqual([])
  })

  it('creates a .gitignore alongside the .env, and merges into an existing one', async () => {
    // Fresh dir: a .gitignore is created with the secret rules.
    const fresh = memFs()
    await generateEnv(opts({ yes: true, token: 't' }), {
      io: scriptIo(),
      fs: fresh,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    expect(fresh.files.get('/work/.gitignore')).toContain('.env')

    // Existing .gitignore: the developer's own rules are preserved and .env stays ignored.
    const existing = memFs({ '/work/.gitignore': '# my rules\ncoverage/\n' })
    await generateEnv(opts({ yes: true, token: 't' }), {
      io: scriptIo(),
      fs: existing,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    const merged = existing.files.get('/work/.gitignore') ?? ''
    expect(merged).toContain('coverage/') // existing content kept verbatim
    expect(merged).toContain('.env') // secret rule merged in
  })

  it('honours --dir for the output directory', async () => {
    const fs = memFs()
    await generateEnv(opts({ yes: true, token: 't', dir: 'deploy/local' }), {
      io: scriptIo(),
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    expect(fs.files.has('/work/deploy/local/.env')).toBe(true)
  })

  it('threads native execution flags into the env', async () => {
    const fs = memFs()
    await generateEnv(
      opts({
        yes: true,
        token: 't',
        executionMode: 'native',
        nativeHarnesses: ['codex'],
        harnessEntry: '/opt/harness/server.js',
      }),
      { io: scriptIo(), fs, cwd: '/work', randomBytes: fixedBytes },
    )
    const env = fs.files.get('/work/.env') ?? ''
    expect(env).toMatch(/^LOCAL_NATIVE_AGENTS=codex$/m)
    expect(env).toMatch(/^LOCAL_HARNESS_ENTRY=\/opt\/harness\/server\.js$/m)
  })
})

describe('generateEnv (existing file)', () => {
  it('refuses to overwrite an existing .env without --force', async () => {
    const fs = memFs({ '/work/.env': 'EXISTING=1\n' })
    await expect(
      generateEnv(opts({ yes: true, token: 't' }), {
        io: scriptIo(),
        fs,
        cwd: '/work',
        randomBytes: fixedBytes,
      }),
    ).rejects.toBeInstanceOf(EnvCommandError)
    // The existing file is untouched.
    expect(fs.files.get('/work/.env')).toBe('EXISTING=1\n')
  })

  it('overwrites with --force', async () => {
    const fs = memFs({ '/work/.env': 'EXISTING=1\n' })
    await generateEnv(opts({ yes: true, token: 't', force: true }), {
      io: scriptIo(),
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    expect(fs.files.get('/work/.env')).not.toBe('EXISTING=1\n')
    expect(fs.files.get('/work/.env')).toContain('DATABASE_URL=')
  })
})

describe('generateEnv (interactive PAT flow)', () => {
  it('opens the pre-scoped URL and writes the pasted token', async () => {
    const fs = memFs()
    // question: db url; selects: provider, runtime; confirms: open-browser, generate-secrets;
    // secret: token.
    const io = scriptIo(
      ['postgres://cat:cat@localhost:5432/catfactory'],
      ['glpat-x'],
      [true, true],
      ['gitlab', 'docker'],
    )
    await generateEnv(opts({}), { io, fs, cwd: '/work', randomBytes: fixedBytes })
    expect(io.opened).toHaveLength(1)
    expect(io.opened[0]).toContain('gitlab.com/-/user_settings/personal_access_tokens')
    const env = fs.files.get('/work/.env') ?? ''
    expect(env).toContain('GITLAB_PAT=glpat-x')
    expect(env).toMatch(/^HARNESS_SHARED_SECRET=/m)
  })

  it('does not open the browser with --no-open', async () => {
    const fs = memFs()
    const io = scriptIo(
      ['postgres://cat:cat@localhost:5432/catfactory'],
      ['ghp_x'],
      [],
      ['github', 'docker'],
    )
    await generateEnv(opts({ noOpen: true }), { io, fs, cwd: '/work', randomBytes: fixedBytes })
    expect(io.opened).toEqual([])
    expect(fs.files.get('/work/.env')).toContain('GITHUB_PAT=ghp_x')
  })

  it('leaves the secrets blank when the developer declines generation', async () => {
    const fs = memFs()
    const warn = vi.fn()
    const io = scriptIo([], [], [false])
    io.warn = warn
    await generateEnv(opts({ provider: 'github', token: 't', executionMode: 'pool' }), {
      io,
      fs,
      cwd: '/work',
      randomBytes: fixedBytes,
    })
    const env = fs.files.get('/work/.env') ?? ''
    expect(env).toMatch(/^AUTH_SESSION_SECRET=$/m)
    expect(env).toMatch(/^HARNESS_SHARED_SECRET=$/m)
    expect(warn).toHaveBeenCalled()
  })
})
