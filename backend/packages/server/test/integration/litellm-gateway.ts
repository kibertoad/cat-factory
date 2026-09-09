import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Support for the LiteLLM gateway integration lane (`litellm.it.spec.ts`): a canned
// OpenAI-compatible UPSTREAM on the host, and a REAL LiteLLM proxy in Docker pointed at it.
//
// Why a stub upstream rather than a provider key: the lane exercises LiteLLM's own translation
// layer, and doing that against a live vendor would bill a token on every CI run for a reply
// nobody reads. LiteLLM's built-in `mock_response` is the obvious alternative and does not serve
// here: it reports `usage` as nulls, so the token assertions would have nothing to read, and it
// answers from inside the proxy, so the two facts this lane cares about most (what the upstream
// is asked for, and with whose key) never leave the container to be observed.
//
// The lane pins GATEWAY behaviour, not our resolver's: `directOpenAiCompatibleResolver` already
// has unit tests. What only a real instance can show is the alias mapping in both directions, the
// key substitution at the upstream hop, and whether usage survives that hop.

/**
 * The LiteLLM release the lane is validated against. Pinned rather than `:latest`, mirroring the
 * repo's other container-backed lanes: an image that moves under the suite turns a gateway
 * behaviour change into a failure attributed to whatever else landed that day.
 */
export const LITELLM_IMAGE = 'ghcr.io/berriai/litellm:v1.100.0'

const CONFIG_PATH = fileURLToPath(new URL('./litellm-config.yaml', import.meta.url))
const CONFIG_SOURCE = readFileSync(CONFIG_PATH, 'utf8')

/**
 * Read one value out of the committed proxy config.
 *
 * Both model names are the operator's, so the config file is where they are declared and this
 * harness reads them back instead of repeating them. Written twice they would need a lockstep
 * edit, and the copy the proxy does not load is the one that goes stale. A shape change in the
 * config fails here, naming the key it could no longer find.
 */
function fromConfig(pattern: RegExp, what: string): string {
  const found = CONFIG_SOURCE.match(pattern)?.[1]
  if (!found) throw new Error(`litellm-config.yaml declares no ${what} (${String(pattern)})`)
  return found
}

/** The `model_name` the committed config declares: the operator's own alias. */
export const GATEWAY_ALIAS = fromConfig(/^[ \t]*-[ \t]*model_name:[ \t]*(\S+)/m, 'model_name')

/**
 * The model that alias maps onto, which is what the upstream is actually asked for. The `openai/`
 * prefix in the config is LiteLLM's provider routing and is stripped before the upstream call, so
 * what the stub sees is only the part after it.
 */
export const UPSTREAM_MODEL = fromConfig(/^[ \t]*model:[ \t]*openai\/(\S+)/m, 'openai/ model')

/**
 * Every synchronous docker call carries its own timeout, because `execFileSync` blocks the event
 * loop: vitest's `hookTimeout` timer cannot fire while one is running, so a wedged daemon or a
 * stalled registry would otherwise hang the worker with only the CI job's own limit to end it.
 */
const DOCKER_TIMEOUTS = {
  info: 20_000,
  inspect: 15_000,
  pull: 180_000,
  run: 120_000,
  logs: 30_000,
  remove: 60_000,
} as const

function dockerCli(args: string[], timeoutMs: number): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs })
}

export function dockerAvailable(): boolean {
  try {
    dockerCli(['info'], DOCKER_TIMEOUTS.info)
    return true
  } catch {
    return false
  }
}

/** What the suite wants the upstream to answer with next. */
export interface StubReply {
  content?: string
  toolCalls?: { name: string; args: unknown }[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

/** One request the upstream received. */
export interface StubRequest {
  method: string
  path: string
  /**
   * EVERY header, not only `authorization`. What the lane asserts is that the caller's gateway key
   * never reaches the upstream, and a proxy forwarding it on some other header (LiteLLM has used
   * `x-litellm-api-key` for pass-through metadata) would sail past a check that reads one field.
   */
  headers: IncomingHttpHeaders
  /** The body as received, for the same reason: a key can ride a field as easily as a header. */
  raw: string
  model: unknown
  stream: boolean
  responseFormat: unknown
  toolNames: string[]
}

export interface UpstreamStub {
  port: number
  /**
   * Every request, recorded BEFORE the route is decided, so one the stub could not route is
   * visible instead of absent. Left unrecorded, a call on an unexpected path would leave the
   * previous test's entry as the newest one, and assertions would pass against a request that
   * never happened.
   */
  requests: StubRequest[]
  /**
   * Transport-level failures: an aborted request, a write to a peer that has gone away, a body
   * that is not JSON. Recorded rather than thrown, because an uncaught exception in a request
   * handler takes the whole vitest worker down instead of failing the test that provoked it. An
   * assertion over {@link requests} is only as good as this staying empty, which the suite checks.
   */
  errors: string[]
  /** Script the next reply. It applies to every subsequent call until changed. */
  reply(next: StubReply): void
  close(): Promise<void>
}

interface ChatCompletionBody {
  model?: unknown
  stream?: boolean
  response_format?: unknown
  tools?: { function?: { name?: string } }[]
}

const DEFAULT_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }

const DEFAULT_REPLY: StubReply = { content: 'stub upstream reply', usage: DEFAULT_USAGE }

/**
 * A canned OpenAI-compatible upstream, bound on 0.0.0.0 so the LiteLLM container can reach it
 * through `host.docker.internal`. That is the one bind here that has to be wide: the gateway's own
 * published port is loopback-only, because nothing dials IT from off the host.
 *
 * It answers `/v1/models` as well as `/v1/chat/completions`. A 404 there is harmless today, but it
 * would make a future LiteLLM startup probe look like a broken upstream, which reads as this
 * lane's own bug rather than as the missing route it is.
 */
export async function startUpstreamStub(): Promise<UpstreamStub> {
  const requests: StubRequest[] = []
  const errors: string[] = []
  let scripted: StubReply = DEFAULT_REPLY

  const note = (phase: string, error: unknown) => {
    errors.push(`${phase}: ${String(error)}`)
  }

  const server: Server = createServer((req, res) => {
    // Without these two listeners an aborted request, or a write to a peer that has gone away
    // (the gateway container is force-removed while its sockets are still live), is an uncaught
    // exception: it kills the worker rather than failing an assertion.
    req.on('error', (error) => note('request', error))
    res.on('error', (error) => note('response', error))

    // Decode as text rather than concatenating Buffers: `raw += chunk` stringifies each chunk on
    // its own, so a multi-byte character split across two TCP reads arrives as U+FFFD.
    req.setEncoding('utf8')
    let raw = ''
    req.on('data', (chunk: string) => {
      raw += chunk
    })
    req.on('end', () => {
      const path = req.url ?? ''
      const method = req.method ?? ''
      let body: ChatCompletionBody = {}
      let parsed = true
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as ChatCompletionBody
        } catch (error) {
          parsed = false
          note('body', error)
        }
      }

      requests.push({
        method,
        path,
        headers: req.headers,
        raw,
        model: body.model,
        stream: body.stream === true,
        responseFormat: body.response_format,
        toolNames: (body.tools ?? []).map((tool) => tool.function?.name ?? '<unnamed>'),
      })

      if (!parsed) {
        writeError(res, 400, 'stub upstream could not parse the request body')
        return
      }
      if (method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: UPSTREAM_MODEL, object: 'model' }] }))
        return
      }
      if (method !== 'POST' || !path.endsWith('/chat/completions')) {
        writeError(res, 404, `stub upstream has no route for ${method} ${path}`)
        return
      }

      if (body.stream === true) writeStream(res, scripted)
      else writeJson(res, scripted)
    })
  })

  await new Promise<void>((ready, failed) => {
    server.once('error', failed)
    server.listen(0, '0.0.0.0', () => {
      server.off('error', failed)
      server.on('error', (error) => note('server', error))
      ready()
    })
  })
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    errors,
    reply: (next) => {
      scripted = next
    },
    close: () =>
      new Promise<void>((closed) => {
        // The gateway container is force-removed before this runs, so its keep-alive sockets to
        // us never send a FIN, and `server.close()` on its own would wait for them: teardown
        // hangs to the hook timeout instead of ending the suite.
        server.closeAllConnections()
        server.close(() => closed())
      }),
  }
}

function toolCallPayloads(reply: StubReply) {
  return (reply.toolCalls ?? []).map((call, index) => ({
    index,
    id: `call_${index}`,
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }))
}

function writeError(res: ServerResponse<IncomingMessage>, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message } }))
}

function writeJson(res: ServerResponse<IncomingMessage>, reply: StubReply): void {
  const toolCalls = toolCallPayloads(reply)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 0,
      model: UPSTREAM_MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: reply.content ?? null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: reply.usage ?? DEFAULT_USAGE,
    }),
  )
}

function writeStream(res: ServerResponse<IncomingMessage>, reply: StubReply): void {
  const toolCalls = toolCallPayloads(reply)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const base = {
    id: 'chatcmpl-stub',
    object: 'chat.completion.chunk',
    created: 0,
    model: UPSTREAM_MODEL,
  }
  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

  if (toolCalls.length > 0) {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: toolCalls } }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    send({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: reply.content ?? '' } }],
    })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  }
  // Sent unconditionally rather than behind `stream_options.include_usage`: the lane asserts the
  // numbers survive the gateway, and a client that never asked for them ignores the chunk.
  send({ ...base, choices: [], usage: reply.usage ?? DEFAULT_USAGE })
  res.write('data: [DONE]\n\n')
  res.end()
}

export interface LiteLlmGateway {
  /** The OpenAI-compatible base URL a deployment would put in `LITELLM_BASE_URL`. */
  baseUrl: string
  /** The gateway credential, standing in for the workspace-pooled `litellm` key. */
  masterKey: string
  /** The credential the config hands the UPSTREAM. It must never appear on a caller's request. */
  upstreamKey: string
  logs(): string
  stop(): void
}

const PULL_ATTEMPTS = 3

/**
 * Put the pinned image on the host, pulling it with a bounded retry when it is absent.
 *
 * The pull is the one thing in this lane that reaches a third party, and the lane is a REQUIRED
 * check, so a 429 or a connection timeout from GHCR must not red a PR that nothing else touched.
 * Same reasoning, and the same shape, as the `test-k8s` job's retry around `k3d cluster create`.
 *
 * Separating the pull from `docker run` is also what makes the run step's timeout meaningful: a
 * bare `run` that pulls is one call whose duration is a registry's to decide.
 */
async function ensureImage(): Promise<void> {
  try {
    dockerCli(['image', 'inspect', LITELLM_IMAGE], DOCKER_TIMEOUTS.inspect)
    return
  } catch {
    // Not on this host yet, which is the normal state of a cold runner.
  }
  let last = ''
  for (let attempt = 1; attempt <= PULL_ATTEMPTS; attempt++) {
    try {
      dockerCli(['pull', LITELLM_IMAGE], DOCKER_TIMEOUTS.pull)
      return
    } catch (error) {
      last = `${String(error)}\n${(error as { stderr?: string }).stderr ?? ''}`
      if (attempt < PULL_ATTEMPTS) await delay(5_000)
    }
  }
  throw new Error(`could not pull ${LITELLM_IMAGE} in ${PULL_ATTEMPTS} attempts: ${last}`)
}

/** The host port Docker published the gateway on, read back rather than chosen in advance. */
function readPublishedPort(name: string): number {
  const mapping = dockerCli(['port', name, '4000/tcp'], DOCKER_TIMEOUTS.inspect).trim()
  const port = Number(mapping.split('\n')[0]?.trim().split(':').at(-1))
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `could not read the published port of ${name}: \`docker port\` said ${mapping || '<nothing>'}`,
    )
  }
  return port
}

/**
 * Start a real LiteLLM proxy against the stub upstream and wait for it to report ready.
 *
 * `--add-host=host.docker.internal:host-gateway` is passed unconditionally. Docker Desktop already
 * resolves that name and re-adding it is inert, while on a Linux runner nothing resolves it
 * without the flag, so one code path serves both rather than branching on the host OS.
 *
 * The proxy runs with NO database, which is how the docs' own quick start runs it and is enough
 * for master-key auth. It also changes what a bad credential looks like, which the suite pins.
 */
export async function startLiteLlmGateway(opts: { upstreamPort: number }): Promise<LiteLlmGateway> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const name = `cat-factory-litellm-it-${suffix}`
  const masterKey = `sk-gateway-${suffix}`
  const upstreamKey = `sk-upstream-${suffix}`
  await ensureImage()

  // `-p 127.0.0.1::4000` lets Docker pick the host port, which is then read back off the running
  // container. Claiming a free port here and releasing it before the run would be a race whose
  // window stretches across container startup: anything taking an ephemeral port meanwhile wins,
  // and `docker run` fails with `port is already allocated`. Loopback rather than every interface,
  // because only this process dials it, and a wider bind puts a live proxy on whatever network the
  // machine running the suite happens to be attached to.
  try {
    dockerCli(
      [
        'run',
        '-d',
        '--name',
        name,
        '--add-host=host.docker.internal:host-gateway',
        '-p',
        '127.0.0.1::4000',
        '-e',
        `LITELLM_MASTER_KEY=${masterKey}`,
        '-e',
        `CAT_FACTORY_IT_UPSTREAM_BASE=http://host.docker.internal:${opts.upstreamPort}/v1`,
        '-e',
        `CAT_FACTORY_IT_UPSTREAM_KEY=${upstreamKey}`,
        '-v',
        `${CONFIG_PATH}:/app/config.yaml:ro`,
        LITELLM_IMAGE,
        '--config',
        '/app/config.yaml',
      ],
      DOCKER_TIMEOUTS.run,
    )
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    throw new Error(`could not start ${LITELLM_IMAGE}: ${String(error)}\n${stderr}`)
  }

  const logs = () => {
    try {
      return dockerCli(['logs', name], DOCKER_TIMEOUTS.logs)
    } catch (error) {
      return `could not read container logs: ${String(error)}`
    }
  }
  const stop = () => {
    try {
      dockerCli(['rm', '-f', name], DOCKER_TIMEOUTS.remove)
    } catch {
      // Already gone, which is the state `stop` exists to reach.
    }
  }
  // Only an explicit `false` counts as exited. A `docker inspect` that fails transiently must not
  // be read as a dead container, or the suite reports a cause it never observed.
  const hasExited = () => {
    try {
      const running = dockerCli(
        ['inspect', '-f', '{{.State.Running}}', name],
        DOCKER_TIMEOUTS.inspect,
      )
      return running.trim() === 'false'
    } catch {
      return false
    }
  }

  try {
    const hostPort = readPublishedPort(name)
    await waitForReady(`http://127.0.0.1:${hostPort}/health/readiness`, hasExited)
    return { baseUrl: `http://127.0.0.1:${hostPort}/v1`, masterKey, upstreamKey, logs, stop }
  } catch (error) {
    // The container's own log is the only thing that says WHY. A readiness timeout on its own is
    // unactionable in CI, because a bad mount and an unreachable upstream time out identically.
    const detail = logs()
    stop()
    throw new Error(`LiteLLM did not come up: ${String(error)}\n--- container logs ---\n${detail}`)
  }
}

async function waitForReady(
  url: string,
  hasExited: () => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url)
      // Drain even a response we are not going to accept: an unread body holds its connection
      // open, and this loop runs once a second until the deadline.
      await res.arrayBuffer()
      if (res.ok) return
    } catch {
      // Not listening yet. The two checks below are what end this loop.
    }
    // A container that has EXITED will never answer, and the likeliest causes (an unparseable
    // config, a bad mount) exit within a second. Polling out the full timeout to say so is the
    // slowest possible path to the most common failure.
    if (hasExited()) throw new Error(`${url} never answered: the gateway container exited`)
    if (Date.now() >= deadline) throw new Error(`${url} did not answer within ${timeoutMs}ms`)
    await delay(1_000)
  }
}
