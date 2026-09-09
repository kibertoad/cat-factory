import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo, createServer as createSocketServer } from 'node:net'
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

/** The `model_name` the committed config declares: the operator's own alias. */
export const GATEWAY_ALIAS = 'cat-factory-it-alias'

/** The model that alias maps onto, which is what the upstream is actually asked for. */
export const UPSTREAM_MODEL = 'stub-upstream-model'

export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
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

/** One request the upstream received, reduced to the fields the lane asserts on. */
export interface StubRequest {
  path: string
  /** The credential the UPSTREAM was shown, never the caller's gateway key. That gap is the point. */
  authorization: string | undefined
  model: unknown
  stream: boolean
  responseFormat: unknown
  toolNames: string[]
}

export interface UpstreamStub {
  port: number
  requests: StubRequest[]
  /** Script the next reply. It applies to every subsequent call until changed. */
  reply(next: StubReply): void
  close(): Promise<void>
}

const DEFAULT_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }

const DEFAULT_REPLY: StubReply = { content: 'stub upstream reply', usage: DEFAULT_USAGE }

/**
 * A canned OpenAI-compatible upstream, bound on 0.0.0.0 so the LiteLLM container can reach it
 * through `host.docker.internal`.
 *
 * It answers `/v1/models` as well as `/v1/chat/completions`. A 404 there is harmless today, but it
 * would make a future LiteLLM startup probe look like a broken upstream, which reads as this
 * lane's own bug rather than as the missing route it is.
 */
export async function startUpstreamStub(): Promise<UpstreamStub> {
  const requests: StubRequest[] = []
  let scripted: StubReply = DEFAULT_REPLY

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const path = req.url ?? ''
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: UPSTREAM_MODEL, object: 'model' }] }))
        return
      }
      if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `stub upstream has no route for ${path}` } }))
        return
      }

      const body = JSON.parse(raw || '{}') as {
        model?: unknown
        stream?: boolean
        response_format?: unknown
        tools?: { function?: { name?: string } }[]
      }
      requests.push({
        path,
        authorization: req.headers.authorization,
        model: body.model,
        stream: body.stream === true,
        responseFormat: body.response_format,
        toolNames: (body.tools ?? []).map((tool) => tool.function?.name ?? '<unnamed>'),
      })

      if (body.stream === true) writeStream(res, scripted)
      else writeJson(res, scripted)
    })
  })

  await new Promise<void>((ready) => server.listen(0, '0.0.0.0', ready))
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    reply: (next) => {
      scripted = next
    },
    close: () => new Promise<void>((closed) => server.close(() => closed())),
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

/** Claim a free host port and release it, so the published port is unlikely to collide. */
async function reservePort(): Promise<number> {
  const socket = createSocketServer()
  await new Promise<void>((ready) => socket.listen(0, '127.0.0.1', ready))
  const { port } = socket.address() as AddressInfo
  await new Promise<void>((closed) => socket.close(() => closed()))
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
  const hostPort = await reservePort()
  const configPath = fileURLToPath(new URL('./litellm-config.yaml', import.meta.url))

  // `docker run` pulls the image when it is absent, which is what makes {@link LITELLM_IMAGE} the
  // single source of the pinned tag: a CI step that pre-pulled it would be the same version
  // written twice, and the copy nobody runs locally is the one that goes stale. The cost is that a
  // cold pull happens inside this call, which is what `hookTimeout` in the integration config is
  // sized for. stderr is captured rather than discarded so a pull or daemon failure arrives as
  // itself instead of as a bare non-zero exit.
  try {
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        name,
        '--add-host=host.docker.internal:host-gateway',
        '-p',
        `${hostPort}:4000`,
        '-e',
        `LITELLM_MASTER_KEY=${masterKey}`,
        '-e',
        `CAT_FACTORY_IT_UPSTREAM_BASE=http://host.docker.internal:${opts.upstreamPort}/v1`,
        '-e',
        `CAT_FACTORY_IT_UPSTREAM_KEY=${upstreamKey}`,
        '-v',
        `${configPath}:/app/config.yaml:ro`,
        LITELLM_IMAGE,
        '--config',
        '/app/config.yaml',
      ],
      { stdio: 'pipe', encoding: 'utf8' },
    )
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    throw new Error(`could not start ${LITELLM_IMAGE}: ${String(error)}\n${stderr}`)
  }

  const logs = () => {
    try {
      return execFileSync('docker', ['logs', name], { encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      return `could not read container logs: ${String(error)}`
    }
  }
  const stop = () => {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
    } catch {
      // Already gone, which is the state `stop` exists to reach.
    }
  }

  try {
    await waitForReady(`http://127.0.0.1:${hostPort}/health/readiness`)
  } catch (error) {
    // The container's own log is the only thing that says WHY. A readiness timeout on its own is
    // unactionable in CI, because a bad mount and an unreachable upstream time out identically.
    const detail = logs()
    stop()
    throw new Error(
      `LiteLLM did not become ready: ${String(error)}\n--- container logs ---\n${detail}`,
    )
  }
  return { baseUrl: `http://127.0.0.1:${hostPort}/v1`, masterKey, upstreamKey, logs, stop }
}

async function waitForReady(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // Not listening yet. The deadline below is what ends this loop.
    }
    if (Date.now() >= deadline) throw new Error(`${url} did not answer within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}
