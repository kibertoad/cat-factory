import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HARNESS_VERSION } from '../version.js'
import {
  serveMcpStdio,
  type McpServerDefinition,
  type McpTool,
  type McpToolResult,
} from './mcp-stdio.js'
import {
  applyAuth,
  credentialSecrets,
  isTargetOrigin,
  loginFields,
  oauthClient,
  scrub,
  targetOrigins,
  type AuthScheme,
  type ResearchCredential,
  type ResearchTarget,
} from './research-tools.logic.js'

// The research run's own tool server, spawned by the agent CLI over stdio. It holds the run's
// credential VALUES so the model never does: it types a login into a page, attaches a token to a
// request, and records a request for a credential the run does not have. A credential only ever
// goes to one of the definition's target origins, and every response is scrubbed before the
// model sees it.

/** Written by the research run to a per-job file; the path is this process's only argument. */
export interface ResearchToolsConfig {
  targets: ResearchTarget[]
  credentials: ResearchCredential[]
  /** Where each recorded HTTP exchange is written, as `http-<n>.json`. */
  evidenceDir: string
  /** Where `request_credential` records the run's request. */
  credentialRequestFile: string
  /** The browser Playwright MCP drives, shared over CDP so a login fills the same session. */
  cdpEndpoint?: string
  /** The installed `playwright` package directory, for the CDP connection. */
  playwrightModule?: string
}

const RESPONSE_TEXT_MAX = 16_000
const EVIDENCE_BODY_MAX = 64_000

/** The research tools as the agent sees them. */
const RESEARCH_TOOLS: McpTool[] = [
  {
    name: 'fill_secret',
    description:
      'Type a stored credential into a field on an open page of a research target, without ' +
      'the value passing through you. Name the field by its label or a CSS selector.',
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
      'Send an HTTP request to a research target, optionally with a stored credential attached, ' +
      'and get the scrubbed response. Each exchange is recorded as evidence under its ref.',
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
      'that needs it, say what you observed (for example the vendor page where it is created), ' +
      'then give your final answer with the findings you have so far.',
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

export function researchTools(config: ResearchToolsConfig): McpServerDefinition {
  const origins = targetOrigins(config.targets)
  const uiOrigins = targetOrigins(config.targets.filter((t) => t.surface === 'ui'))
  const secrets = credentialSecrets(config.credentials)
  const tokens = new Map<string, string>()
  let exchanges = 0
  const credential = (key: unknown) =>
    typeof key === 'string' ? config.credentials.find((c) => c.key === key) : undefined
  const refuse = (text: string): McpToolResult => ({ text, isError: true })

  async function fillSecret(args: Record<string, unknown>): Promise<McpToolResult> {
    const found = credential(args.credentialKey)
    if (!found) return refuse(`No credential '${String(args.credentialKey)}' is available.`)
    const field = args.field === 'username' || args.field === 'password' ? args.field : 'value'
    const login = found.kind === 'login' ? loginFields(found.value) : null
    const value = field === 'value' ? found.value : login?.[field]
    if (value === undefined) {
      return refuse(
        `Credential '${found.key}' has no ${field}; use field "value" for a ${found.kind}.`,
      )
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
        'No open page on one of the research targets has that field. A credential is only typed ' +
          'into a page on a target origin.',
      )
    } finally {
      // Disconnects this client only; the browser stays up for Playwright MCP.
      await browser.close()
    }
  }

  async function accessToken(found: ResearchCredential): Promise<string> {
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
    const res = await fetch(client.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
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
      return refuse(
        `${rawUrl || 'That URL'} is not on one of the research targets, so it was not sent.`,
      )
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
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) })
    const responseText = scrub(await res.text(), secrets)
    const responseHeaders = scrub(
      [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'),
      secrets,
    )
    exchanges += 1
    const ref = `http-${exchanges}`
    await writeFile(
      join(config.evidenceDir, `${ref}.json`),
      JSON.stringify(
        {
          request: {
            method,
            url: scrub(url, secrets),
            headers: Object.fromEntries(
              Object.entries(headers)
                .filter(([name]) => name !== 'authorization')
                .map(([name, value]) => [name, scrub(value, secrets)]),
            ),
            ...(body !== undefined
              ? { body: scrub(body, secrets).slice(0, EVIDENCE_BODY_MAX) }
              : {}),
          },
          response: {
            status: res.status,
            headers: responseHeaders,
            body: responseText.slice(0, EVIDENCE_BODY_MAX),
          },
        },
        null,
        2,
      ),
    )
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
    await writeFile(
      config.credentialRequestFile,
      JSON.stringify({
        key,
        reason: typeof args.reason === 'string' ? scrub(args.reason, secrets) : '',
        observed: typeof args.observed === 'string' ? scrub(args.observed, secrets) : '',
      }),
    )
    return {
      text:
        'Recorded. Stop now: give your final answer with the findings you have, marking each ' +
        `question that needs '${key}' as blocked on it. The run resumes once a person provides it.`,
    }
  }

  return {
    name: 'cat-factory-research',
    version: HARNESS_VERSION ?? 'unknown',
    tools: RESEARCH_TOOLS,
    call(name, args) {
      if (name === 'fill_secret') return fillSecret(args)
      if (name === 'http_request') return httpRequest(args)
      return requestCredential(args)
    },
  }
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

// Entry point: `node research-tools-server.js <config.json>`.
const configPath = process.argv[2]
if (configPath && process.argv[1]?.endsWith('research-tools-server.js')) {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as ResearchToolsConfig
  serveMcpStdio(researchTools(config))
}
