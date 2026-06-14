import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Full-blown acceptance test: it builds and launches the real Docker image and
// drives a complete `POST /run` — clone → Pi implements → commit → push → open
// PR — with the LLM served by a **dummy adapter** that returns hardcoded
// streaming responses (no real provider, no real GitHub). It asserts the file
// landed on a pushed branch and that the PR was opened.
//
// The repo is a bind-mounted local bare repo (cloned via file://), and the
// LLM proxy + GitHub API are local stub servers the container reaches over
// host.docker.internal. Self-skips when no Docker daemon is available.

const PKG_DIR = fileURLToPath(new URL('../../', import.meta.url))
const IMAGE = 'cat-factory-impl-acceptance'

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  return (server.address() as AddressInfo).port
}

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((resolve) => s.listen(0, resolve))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

/** Dummy LLM proxy: streams a `write` tool call, then a final stop message. */
function makeDummyProxy() {
  const requests: { auth?: string; model?: string; hasTools: boolean }[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const json = JSON.parse(body || '{}') as {
        model?: string
        tools?: unknown[]
        messages?: { role?: string }[]
      }
      requests.push({
        auth: req.headers.authorization,
        model: json.model,
        hasTools: Array.isArray(json.tools),
      })
      const sawToolResult = (json.messages ?? []).some((m) => m.role === 'tool')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = {
        id: 'chatcmpl-x',
        object: 'chat.completion.chunk',
        created: 0,
        model: json.model,
      }
      const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      if (!sawToolResult) {
        // Turn 1: emit a streamed `write` tool call to create the file.
        sse({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'write', arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        sse({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: JSON.stringify({
                        path: 'IMPLEMENTED.md',
                        content: 'hello from pi\n',
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        // Turn 2: final assistant message + stop + usage.
        sse({
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Created IMPLEMENTED.md as requested.' },
              finish_reason: null,
            },
          ],
        })
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        sse({
          ...base,
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return { server, requests }
}

/** Stub GitHub API: captures the PR request and returns a fixed html_url. */
function makeGitHubStub() {
  const pulls: { url: string; body: Record<string, unknown>; auth?: string }[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.method === 'POST' && (req.url ?? '').endsWith('/pulls')) {
        pulls.push({
          url: req.url ?? '',
          body: JSON.parse(body || '{}') as Record<string, unknown>,
          auth: req.headers.authorization,
        })
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ html_url: 'http://gh.test/octo/app/pull/1', number: 1 }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  return { server, pulls }
}

const docker = dockerAvailable()

describe.skipIf(!docker)('implementer container acceptance', () => {
  let work: string
  let bare: string

  beforeAll(() => {
    // Build the image. Pass the sandbox proxy CA as a build secret when present
    // (no-op in normal environments).
    const ca = process.env.NODE_EXTRA_CA_CERTS
    const caArgs = ca && existsSync(ca) ? ['--secret', `id=extra_ca,src=${ca}`] : []
    execFileSync('docker', ['build', ...caArgs, '-f', 'Dockerfile', '-t', IMAGE, '.'], {
      cwd: PKG_DIR,
      stdio: 'inherit',
    })

    // A local bare repo with a seeded `main`, bind-mounted into the container.
    work = mkdtempSync(join(tmpdir(), 'cf-acc-'))
    bare = join(work, 'repo.git')
    const seed = join(work, 'seed')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare])
    execFileSync('git', ['clone', bare, seed], { stdio: 'ignore' })
    writeFileSync(join(seed, 'README.md'), '# seed\n')
    const g = (...args: string[]) => execFileSync('git', ['-C', seed, ...args], { stdio: 'ignore' })
    g('-c', 'user.email=seed@test', '-c', 'user.name=seed', 'add', '-A')
    g('-c', 'user.email=seed@test', '-c', 'user.name=seed', 'commit', '-m', 'init')
    g('push', 'origin', 'main')
  })

  afterAll(() => {
    if (!work) return
    // The container (root) wrote git objects into the bind mount; hand them back
    // to this user so the dir can be removed. Override the image entrypoint
    // (which is the harness server) to actually run chown, and cap it with a
    // timeout so cleanup can never hang the suite.
    try {
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          'chown',
          '-v',
          `${work}:/w`,
          IMAGE,
          '-R',
          `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          '/w',
        ],
        { stdio: 'ignore', timeout: 60_000 },
      )
    } catch {
      // best effort
    }
    rmSync(work, { recursive: true, force: true })
  })

  const containers: string[] = []
  afterEach(() => {
    for (const name of containers.splice(0)) {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
      } catch {
        // already gone
      }
    }
  })

  it('clones, runs Pi, pushes a branch and opens a PR', async () => {
    const proxy = makeDummyProxy()
    const github = makeGitHubStub()
    const proxyPort = await listen(proxy.server)
    const ghPort = await listen(github.server)
    const hostPort = await freePort()
    const name = `cf-acc-${Date.now()}`
    containers.push(name)

    // The bind-mounted repo is owned by another uid (esp. on CI's non-root
    // runner); the image sets safe.directory=* system-wide so git won't reject it
    // for "dubious ownership" (git ignores that setting from env, only system/global).
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        name,
        '--add-host=host.docker.internal:host-gateway',
        '-p',
        `${hostPort}:8080`,
        '-v',
        `${bare}:/srv/repo`,
        IMAGE,
      ],
      { stdio: 'ignore' },
    )

    // Wait for the harness HTTP server.
    const healthDeadline = Date.now() + 30_000
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${hostPort}/health`)
        if (r.ok) break
      } catch {
        // not up yet
      }
      if (Date.now() > healthDeadline) throw new Error('container did not become healthy')
      await sleep(500)
    }

    const job = {
      systemPrompt: 'You are a builder. Create exactly the file the user asks for.',
      userPrompt: 'Create IMPLEMENTED.md containing "hello from pi".',
      model: 'dummy-model',
      proxyBaseUrl: `http://host.docker.internal:${proxyPort}/v1`,
      sessionToken: 'dummy-session-token',
      ghToken: 'dummy-gh-token',
      repo: { owner: 'octo', name: 'app', baseBranch: 'main', cloneUrl: 'file:///srv/repo' },
      headBranch: 'cat-factory/acc-1',
      pr: { title: 'Add IMPLEMENTED.md', body: 'Automated by acceptance test' },
      githubApiBase: `http://host.docker.internal:${ghPort}`,
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 180_000)
    let result: { prUrl?: string; branch?: string; summary?: string; error?: string }
    try {
      const res = await fetch(`http://127.0.0.1:${hostPort}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
        signal: ac.signal,
      })
      expect(res.status).toBe(200)
      result = (await res.json()) as typeof result
    } finally {
      clearTimeout(timer)
      proxy.server.close()
      github.server.close()
    }

    // --- The run succeeded and returned the stub PR url + Pi's summary. -------
    expect(result.error).toBeUndefined()
    expect(result.prUrl).toBe('http://gh.test/octo/app/pull/1')
    expect(result.branch).toBe('cat-factory/acc-1')
    expect(result.summary).toContain('Created IMPLEMENTED.md')

    // --- Pi actually talked to the dummy proxy (with the session token). ------
    expect(proxy.requests.length).toBeGreaterThanOrEqual(2)
    expect(proxy.requests[0]!.model).toBe('dummy-model')
    expect(proxy.requests[0]!.hasTools).toBe(true)
    expect(proxy.requests[0]!.auth).toBe('Bearer dummy-session-token')

    // --- The PR was opened against the stub with the right head/base. ---------
    expect(github.pulls).toHaveLength(1)
    expect(github.pulls[0]!.body).toMatchObject({
      head: 'cat-factory/acc-1',
      base: 'main',
      title: 'Add IMPLEMENTED.md',
    })
    expect(github.pulls[0]!.auth).toBe('Bearer dummy-gh-token')

    // --- The branch was pushed to the repo with the new file committed. -------
    const branchSha = execFileSync('git', [
      '-C',
      bare,
      'rev-parse',
      '--verify',
      'cat-factory/acc-1',
    ])
      .toString()
      .trim()
    expect(branchSha).toMatch(/^[0-9a-f]{40}$/)
    const fileContent = execFileSync('git', [
      '-C',
      bare,
      'show',
      'cat-factory/acc-1:IMPLEMENTED.md',
    ]).toString()
    expect(fileContent).toContain('hello from pi')
  })
})

if (!docker) {
  // Visible signal in CI logs when the suite is skipped for lack of Docker.
  // eslint-disable-next-line no-console
  console.warn('[acceptance] Docker not available — skipping container acceptance tests')
}
