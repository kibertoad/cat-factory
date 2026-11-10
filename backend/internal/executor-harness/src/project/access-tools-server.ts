import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HARNESS_VERSION } from '../version.js'
import {
  handleMcpMessage,
  type JsonRpcRequest,
  type McpServerDefinition,
  type McpTool,
  type McpToolResult,
} from './mcp-protocol.js'
import {
  applyAuth,
  credentialSecrets,
  isTargetOrigin,
  loginFields,
  oauthClient,
  scrub,
  targetOrigins,
  type AuthScheme,
  type AccessCredential,
  type AccessTarget,
} from './access-tools.logic.js'

// A project run's access tool server. It holds the run's credential VALUES so the model never
// does: it types a login into a page, attaches a token to a request, and records a request for a
// credential the run does not have. A credential only ever goes to one of the definition's target
// origins, and every response is scrubbed before the model sees it.
//
// It runs inside the harness process, never in a process the agent CLI spawns: the agent has a
// shell, so a value written to a config file or handed to a child it can inspect is a value the
// model can read. The CLI reaches it through `access-tools-proxy.ts`, a stdio bridge that holds
// only this server's loopback URL and a per-job token, which grant the tools and nothing more.

export interface AccessToolsConfig {
  targets: AccessTarget[]
  credentials: AccessCredential[]
  /** The browser Playwright MCP drives, shared over CDP so a login fills the same session. */
  cdpEndpoint?: string
  /** The installed `playwright` package directory, for the CDP connection. */
  playwrightModule?: string
  /** The job's cancellation, so an in-flight vendor request ends with the run. */
  signal?: AbortSignal
}

/** One `http_request` exchange as recorded for the result, already scrubbed. */
export interface HttpExchange {
  request: { method: string; url: string; headers: Record<string, string>; body?: string }
  response: { status: number; headers: string; body: string }
}

/** The credential the agent asked a person for, when it stopped to wait for one. */
export interface CredentialRequest {
  key: string
  reason: string
  observed: string
}

/** What the tools recorded over the run, read by the job once the agent has finished. */
export interface AccessToolsRecord {
  httpExchanges: Array<{ ref: string; exchange: HttpExchange }>
  needsCredential?: CredentialRequest
}

export interface AccessTools {
  definition: McpServerDefinition
  recorded(): AccessToolsRecord
}

const RESPONSE_TEXT_MAX = 16_000
const EVIDENCE_BODY_MAX = 64_000
const HTTP_TIMEOUT_MS = 60_000

/** The access tools as the agent sees them. */
const ACCESS_TOOLS: McpTool[] = [
  {
    name: 'fill_secret',
    description:
      'Type a stored credential into a field on an open page of a project target, without ' +
      'the value passing through you. Name the field by its label or a CSS selector. A login ' +
      'has a username and a password; every other credential has a value.',
    inputSchema: {
      type: 'object',
      properties: {
        credentialKey: { type: 'string' },
        field: { type: 'string', enum: ['username', 'password', 'value'] },
        label: { type: 'string' },
        selector: { type: 'string' },
      },
      required: ['credentialKey', 'field'],
    },
  },
  {
    name: 'http_request',
    description:
      'Send an HTTP request to a project target, optionally with a stored credential attached, ' +
      'and get the scrubbed response. Each exchange is recorded as evidence under its ref. ' +
      'Redirects are not followed: a redirect comes back with its location, which you may request.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: {},
        auth: {
          type: 'object',
          properties: {
            credentialKey: { type: 'string' },
            scheme: {
              type: 'string',
              enum: ['bearer', 'basic', 'header', 'query', 'oauth-client'],
            },
            name: { type: 'string', description: 'The header or query parameter name.' },
          },
          required: ['credentialKey', 'scheme'],
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'request_credential',
    description:
      'Ask a person for a credential this run does not have. Call it when you reach a point ' +
      'that needs it, say what you observed (for example the page where it is created), ' +
      'then give your final answer with what you have so far.',
    inputSchema: {
      type: 'object',
      properties: {
        credentialKey: { type: 'string' },
        reason: { type: 'string' },
        observed: { type: 'string' },
      },
      required: ['credentialKey', 'reason'],
    },
  },
]

export function accessTools(config: AccessToolsConfig): AccessTools {
  const origins = targetOrigins(config.targets)
  const uiOrigins = targetOrigins(config.targets.filter((t) => t.surface === 'ui'))
  const secrets = credentialSecrets(config.credentials)
  const tokens = new Map<string, string>()
  const httpExchanges: AccessToolsRecord['httpExchanges'] = []
  let needsCredential: CredentialRequest | undefined
  const credential = (key: unknown) =>
    typeof key === 'string' ? config.credentials.find((c) => c.key === key) : undefined
  const refuse = (text: string): McpToolResult => ({ text, isError: true })
  const requestSignal = () => {
    const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS)
    return config.signal ? AbortSignal.any([timeout, config.signal]) : timeout
  }

  async function fillSecret(args: Record<string, unknown>): Promise<McpToolResult> {
    const found = credential(args.credentialKey)
    if (!found) return refuse(`No credential '${String(args.credentialKey)}' is available.`)
    const field = args.field === 'username' || args.field === 'password' ? args.field : 'value'
    let value: string | undefined
    if (found.kind === 'login') {
      // A login is stored as JSON; that document is never what a single field should receive.
      value = field === 'value' ? undefined : loginFields(found.value)?.[field]
    } else {
      value = field === 'value' ? found.value : undefined
    }
    if (value === undefined) {
      const fields = found.kind === 'login' ? '"username" or "password"' : '"value"'
      return refuse(`Credential '${found.key}' has no ${field}; use field ${fields}.`)
    }
    if (!config.cdpEndpoint || !config.playwrightModule) {
      return refuse('No browser is available to this run.')
    }
    const label = typeof args.label === 'string' ? args.label : undefined
    const selector = typeof args.selector === 'string' ? args.selector : undefined
    if (!label && !selector) return refuse('Name the field by its `label` or a CSS `selector`.')
    const playwright = (await import(
      pathToFileURL(join(config.playwrightModule, 'index.mjs')).href
    )) as {
      chromium: { connectOverCDP(endpoint: string): Promise<CdpBrowser> }
    }
    const browser = await playwright.chromium.connectOverCDP(config.cdpEndpoint)
    try {
      for (const page of browser.contexts().flatMap((context) => context.pages())) {
        // Only a page on a UI target is ever filled, so a login cannot be typed into a page a
        // prompt injection navigated the browser to.
        if (!isTargetOrigin(page.url(), uiOrigins)) continue
        const locator = label ? page.getByLabel(label) : page.locator(selector!)
        if ((await locator.count()) === 0) continue
        await locator.first().fill(value)
        return { text: `Filled the ${field} of '${found.key}' on ${new URL(page.url()).origin}.` }
      }
      return refuse(
        'No open page on one of the targets has that field. A credential is only typed ' +
          'into a page on a target origin.',
      )
    } finally {
      // Disconnects this client only; the browser stays up for Playwright MCP.
      await browser.close()
    }
  }

  async function accessToken(found: AccessCredential): Promise<string> {
    const cached = tokens.get(found.key)
    if (cached) return cached
    const client = oauthClient(found.value)
    if (!client) throw new Error(`Credential '${found.key}' is not a readable OAuth client.`)
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      ...(client.scope ? { scope: client.scope } : {}),
    })
    // A redirect would resend the client secret to wherever it points, so none is followed.
    const res = await fetch(client.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal: requestSignal(),
    })
    const parsed = (await res.json().catch(() => null)) as { access_token?: unknown } | null
    if (!res.ok || typeof parsed?.access_token !== 'string') {
      throw new Error(`The OAuth token exchange for '${found.key}' failed (HTTP ${res.status}).`)
    }
    tokens.set(found.key, parsed.access_token)
    secrets.push(parsed.access_token)
    return parsed.access_token
  }

  async function httpRequest(args: Record<string, unknown>): Promise<McpToolResult> {
    const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET'
    const rawUrl = typeof args.url === 'string' ? args.url : ''
    if (!isTargetOrigin(rawUrl, origins)) {
      return refuse(`${rawUrl || 'That URL'} is not on one of the targets, so it was not sent.`)
    }
    let url = rawUrl
    let headers: Record<string, string> = {}
    for (const [name, value] of Object.entries((args.headers ?? {}) as Record<string, unknown>)) {
      if (typeof value === 'string') headers[name.toLowerCase()] = value
    }
    const auth = args.auth as
      | { credentialKey?: unknown; scheme?: unknown; name?: unknown }
      | undefined
    if (auth) {
      const found = credential(auth.credentialKey)
      if (!found) return refuse(`No credential '${String(auth.credentialKey)}' is available.`)
      const scheme = parseScheme(auth.scheme, auth.name)
      if (!scheme)
        return refuse('Unknown auth scheme; use bearer, basic, header, query or oauth-client.')
      if (scheme.scheme === 'oauth-client') {
        ;({ url, headers } = applyAuth(
          url,
          headers,
          { scheme: 'bearer' },
          await accessToken(found),
        ))
      } else {
        ;({ url, headers } = applyAuth(url, headers, scheme, found.value))
      }
    }
    const body =
      typeof args.body === 'string'
        ? args.body
        : args.body === undefined
          ? undefined
          : JSON.stringify(args.body)
    // Redirects are handed back rather than followed: fetch keeps a custom auth header (and a
    // query credential's URL) on a redirect to another origin, so following one would carry the
    // credential past the target check above. The agent's next request is checked again.
    const res = await fetch(url, {
      method,
      headers,
      redirect: 'manual',
      signal: requestSignal(),
      ...(body !== undefined ? { body } : {}),
    })
    const responseText = scrub(await res.text(), secrets)
    const responseHeaders = scrub(
      [...res.headers.entries()].map(([k, v]) => `${k}: ${responseHeaderValue(k, v)}`).join('\n'),
      secrets,
    )
    const ref = `http-${httpExchanges.length + 1}`
    httpExchanges.push({
      ref,
      exchange: {
        request: {
          method,
          url: scrub(url, secrets),
          headers: Object.fromEntries(
            Object.entries(headers)
              .filter(([name]) => name !== 'authorization')
              .map(([name, value]) => [name, scrub(value, secrets)]),
          ),
          ...(body !== undefined ? { body: scrub(body, secrets).slice(0, EVIDENCE_BODY_MAX) } : {}),
        },
        response: {
          status: res.status,
          headers: responseHeaders,
          body: responseText.slice(0, EVIDENCE_BODY_MAX),
        },
      },
    })
    const shown = responseText.slice(0, RESPONSE_TEXT_MAX)
    const cut =
      responseText.length > shown.length
        ? `\n[cut: ${responseText.length - shown.length} more characters]`
        : ''
    return {
      text: `evidence ref: ${ref}\nHTTP ${res.status}\n${responseHeaders}\n\n${shown}${cut}`,
    }
  }

  async function requestCredential(args: Record<string, unknown>): Promise<McpToolResult> {
    const key = typeof args.credentialKey === 'string' ? args.credentialKey : ''
    if (!key) return refuse('Name the credential you need by its key.')
    needsCredential = {
      key,
      reason: typeof args.reason === 'string' ? scrub(args.reason, secrets) : '',
      observed: typeof args.observed === 'string' ? scrub(args.observed, secrets) : '',
    }
    return {
      text:
        'Recorded. Stop now: give your final answer with what you have so far, and say in it ' +
        `which part of the work waits on '${key}'. The run resumes once a person provides it.`,
    }
  }

  return {
    definition: {
      name: 'cat-factory-project-access',
      version: HARNESS_VERSION ?? 'unknown',
      tools: ACCESS_TOOLS,
      call(name, args) {
        if (name === 'fill_secret') return fillSecret(args)
        if (name === 'http_request') return httpRequest(args)
        return requestCredential(args)
      },
    },
    recorded: () => ({
      httpExchanges: [...httpExchanges],
      ...(needsCredential ? { needsCredential } : {}),
    }),
  }
}

/** A session cookie is a credential the run never knew, so only its name reaches the model. */
function responseHeaderValue(name: string, value: string): string {
  return name === 'set-cookie' ? value.replace(/^([^=;]*)=[^;]*/, '$1=***') : value
}

function parseScheme(scheme: unknown, name: unknown): AuthScheme | null {
  if (scheme === 'bearer' || scheme === 'basic' || scheme === 'oauth-client') return { scheme }
  if ((scheme === 'header' || scheme === 'query') && typeof name === 'string' && name) {
    return { scheme, name }
  }
  return null
}

interface CdpLocator {
  count(): Promise<number>
  first(): { fill(value: string): Promise<void> }
}
interface CdpPage {
  url(): string
  getByLabel(label: string): CdpLocator
  locator(selector: string): CdpLocator
}
interface CdpBrowser {
  contexts(): Array<{ pages(): CdpPage[] }>
  close(): Promise<void>
}

/** The in-process endpoint the stdio bridge forwards to. */
export interface AccessToolsHost {
  /** Loopback URL taking one JSON-RPC message per POST. */
  url: string
  /** Bearer token the bridge must present; it grants the tools and no credential value. */
  token: string
  close(): Promise<void>
}

const MAX_MESSAGE_BYTES = 1_000_000

/** Serve a tool definition on a loopback port for this job only. */
export async function startAccessToolsHost(
  definition: McpServerDefinition,
): Promise<AccessToolsHost> {
  const token = randomBytes(32).toString('hex')
  const want = Buffer.from(`Bearer ${token}`)
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status).end()
      return
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/mcp') return send(res, 404)
      const got = Buffer.from(req.headers.authorization ?? '')
      if (got.length !== want.length || !timingSafeEqual(got, want)) return send(res, 401)
      const raw = await readMessage(req)
      if (raw === undefined) return send(res, 413)
      let message: JsonRpcRequest
      try {
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object')
        }
        message = parsed as JsonRpcRequest
      } catch {
        return send(res, 200, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'parse error' },
        })
      }
      const response = await handleMcpMessage(definition, message)
      return response ? send(res, 200, response) : send(res, 204)
    })().catch(() => {
      if (!res.headersSent) send(res, 500)
      else res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function readMessage(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_MESSAGE_BYTES) return undefined
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
