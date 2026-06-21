import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Shared plumbing for the Docker-based acceptance tests: build/launch the image,
// stand up local stub servers (LLM upstream + GitHub API), seed a bind-mounted
// bare repo, and talk to the container. Used by both the dummy-proxy E2E and the
// real-proxy (in-process LlmProxyController) E2E.

export const PKG_DIR = fileURLToPath(new URL('../../', import.meta.url))
export const IMAGE = 'cat-factory-impl-acceptance'

export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  return (server.address() as AddressInfo).port
}

export async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((resolve) => s.listen(0, resolve))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

/** Build the executor image. Passes the sandbox proxy CA as a build secret when present. */
export function buildImage(): void {
  // In CI the image is pre-built with layer caching in a dedicated workflow step
  // (docker/build-push-action with a GHA cache) and loaded into the daemon under
  // IMAGE, so skip the redundant — and uncached — local rebuild here.
  if (process.env.ACCEPTANCE_PREBUILT_IMAGE === '1') return
  const ca = process.env.NODE_EXTRA_CA_CERTS
  const caArgs = ca && existsSync(ca) ? ['--secret', `id=extra_ca,src=${ca}`] : []
  execFileSync('docker', ['build', ...caArgs, '-f', 'Dockerfile', '-t', IMAGE, '.'], {
    cwd: PKG_DIR,
    stdio: 'inherit',
  })
}

/** Create a local bare repo with a seeded `main` branch; returns its paths. */
export function seedBareRepo(): { work: string; bare: string } {
  const work = mkdtempSync(join(tmpdir(), 'cf-acc-'))
  const bare = join(work, 'repo.git')
  const seed = join(work, 'seed')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  execFileSync('git', ['clone', bare, seed], { stdio: 'ignore' })
  writeFileSync(join(seed, 'README.md'), '# seed\n')
  const g = (...args: string[]) => execFileSync('git', ['-C', seed, ...args], { stdio: 'ignore' })
  g('-c', 'user.email=seed@test', '-c', 'user.name=seed', 'add', '-A')
  g('-c', 'user.email=seed@test', '-c', 'user.name=seed', 'commit', '-m', 'init')
  g('push', 'origin', 'main')
  // The image now runs as an unprivileged `harness` user (uid 999) whose uid
  // differs from the host uid that owns this bind-mounted bare repo (e.g. 1001 on
  // CI). Clone only reads it, but `git push file:///srv/repo` writes objects/refs
  // back, and `git init --bare` leaves the repo mode 0755/0644 — so the push
  // fails with "Permission denied". Make the repo group/other-writable so the
  // container user can push. (Production never bind-mounts: it clones/pushes over
  // HTTPS into a harness-owned tmpdir.) reclaimMount() chowns the harness-created
  // objects back to the host uid afterwards. Skipped on Windows (no chmod / no
  // POSIX perms; Docker Desktop bind mounts are writable regardless of uid).
  if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'a+rwX', bare])
  return { work, bare }
}

/** The container (root) wrote git objects into the mount; chown them back, then the caller removes the dir. */
export function reclaimMount(work: string): void {
  try {
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        // The image now drops to an unprivileged user; chown needs root.
        '--user',
        '0:0',
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
}

/** Start a detached container with the bare repo bind-mounted and the harness port published. */
export function startContainer(name: string, hostPort: number, bare: string): void {
  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '--add-host=host.docker.internal:host-gateway',
      // The harness restricts which hosts may receive the GitHub token; the
      // stub GitHub API is reached over host.docker.internal, so allow it.
      '-e',
      'GITHUB_ALLOWED_HOSTS=host.docker.internal',
      '-p',
      `${hostPort}:8080`,
      '-v',
      `${bare}:/srv/repo`,
      IMAGE,
    ],
    { stdio: 'ignore' },
  )
}

export function removeContainer(name: string): void {
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  } catch {
    // already gone
  }
}

export async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      if (r.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('container did not become healthy')
    await sleep(500)
  }
}

/** A single chat-completions request the LLM stub observed. */
export interface StubRequest {
  auth?: string
  model?: string
  hasTools: boolean
}

/** One scripted tool call a streaming stub emits, in order. */
interface ScriptedCall {
  name: string
  args: Record<string, unknown>
}

/** OpenAI-style usage a stub reports on its final chunk. */
interface StubUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/**
 * The shared canned OpenAI-compatible streaming endpoint behind every stub below.
 * Per request it emits the next scripted tool call (keyed on how many `tool`
 * messages the transcript already carries — Pi adds one per completed call), and
 * once the script is exhausted streams a final assistant message + stop + a usage
 * chunk. A 1-element script therefore behaves exactly like the original two-turn
 * stub: first call → the tool, any later call (a tool result is present) → the
 * final message + usage.
 */
function scriptedStreamingStub(script: ScriptedCall[], summary: string, usage: StubUsage) {
  const requests: StubRequest[] = []
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
      // The transcript carries one `tool` message per completed call, so the count
      // of them is the index of the next scripted call to emit.
      const turn = (json.messages ?? []).filter((m) => m.role === 'tool').length
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = {
        id: 'chatcmpl-x',
        object: 'chat.completion.chunk',
        created: 0,
        model: json.model,
      }
      const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)

      const call = script[turn]
      if (call) {
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
                    id: `call_${turn}`,
                    type: 'function',
                    function: { name: call.name, arguments: '' },
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
                tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.args) } }],
              },
              finish_reason: null,
            },
          ],
        })
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        sse({
          ...base,
          choices: [
            { index: 0, delta: { role: 'assistant', content: summary }, finish_reason: null },
          ],
        })
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        sse({ ...base, choices: [], usage })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return { server, requests }
}

/** Pi's `write` tool call that creates IMPLEMENTED.md. */
const WRITE_FILE_CALL: ScriptedCall = {
  name: 'write',
  args: { path: 'IMPLEMENTED.md', content: 'hello from pi\n' },
}

/**
 * The agent commits its OWN work — the harness no longer blanket-stages, so a run
 * that writes a file but never commits it is (correctly) a no-op. Every stub that
 * expects a pushed branch + PR therefore drives this commit after the write.
 */
const COMMIT_CALL: ScriptedCall = {
  name: 'bash',
  args: { command: 'git add IMPLEMENTED.md && git commit -m "Add IMPLEMENTED.md"' },
}

/**
 * A canned OpenAI-compatible streaming endpoint: first turn streams a `write` tool
 * call that creates IMPLEMENTED.md; on the next turn (after the tool result) it
 * streams a final assistant message + stop + a usage chunk. The "dummy adapter
 * with hardcoded responses" used to exercise the proxy itself — it stops at the
 * write, so it does NOT drive a commit/push.
 */
export function streamingLlmStub(summary = 'Created IMPLEMENTED.md as requested.') {
  return scriptedStreamingStub([WRITE_FILE_CALL], summary, {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
  })
}

/**
 * Like {@link streamingLlmStub} but it also drives the commit-it-yourself contract:
 * after the `write` it issues a `bash` tool call that commits the file, so the
 * harness sees real work on the branch and pushes it + opens the PR. Used by the
 * full container happy-path E2E.
 */
export function committingLlmStub(summary = 'Created IMPLEMENTED.md as requested.') {
  return scriptedStreamingStub([WRITE_FILE_CALL, COMMIT_CALL], summary, {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
  })
}

/**
 * A streaming stub that drives a *real* multi-step tool conversation so the
 * container exercises the rpiv-todo extension end to end: it creates a 3-item
 * todo list, completes two items and marks the third in-progress, writes the
 * file, then commits it. Pi runs each call and feeds the tool result back, so the
 * harness sees genuine `todo` `tool_result` events and reports subtask progress.
 */
export function todoDrivingLlmStub(summary = 'Created IMPLEMENTED.md as requested.') {
  const script: ScriptedCall[] = [
    { name: 'todo', args: { action: 'create', subject: 'Set up the workspace' } },
    { name: 'todo', args: { action: 'create', subject: 'Write IMPLEMENTED.md' } },
    { name: 'todo', args: { action: 'create', subject: 'Double-check the file' } },
    { name: 'todo', args: { action: 'update', id: 1, status: 'completed' } },
    { name: 'todo', args: { action: 'update', id: 2, status: 'completed' } },
    {
      name: 'todo',
      args: { action: 'update', id: 3, status: 'in_progress', activeForm: 'double-checking' },
    },
    WRITE_FILE_CALL,
    COMMIT_CALL,
  ]
  return scriptedStreamingStub(script, summary, {
    prompt_tokens: 20,
    completion_tokens: 8,
    total_tokens: 28,
  })
}

/** A captured pull-request creation. */
export interface StubPull {
  url: string
  body: Record<string, unknown>
  auth?: string
}

/** A stub GitHub API that captures POST .../pulls and returns a fixed html_url. */
export function githubStub() {
  const pulls: StubPull[] = []
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
