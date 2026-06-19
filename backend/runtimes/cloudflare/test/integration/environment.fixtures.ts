import type { EnvironmentManifest } from '@cat-factory/kernel'

// Shared fixtures for the environment-provider integration tests. The real
// HttpEnvironmentProvider is exercised against a stubbed global `fetch` that acts
// as an org's self-rolled management API and records every request.

export const TEST_API_TOKEN = 'super-secret-token'
export const TEST_BASE = 'https://envs.test/api'

/** A representative manifest (bearer-auth) the specs register and tweak. */
export function bearerManifest(overrides: Partial<EnvironmentManifest> = {}): EnvironmentManifest {
  return {
    providerId: 'acme-envs',
    label: 'Acme Ephemeral Envs',
    baseUrl: TEST_BASE,
    auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
    provision: {
      method: 'POST',
      pathTemplate: '/environments',
      bodyTemplate: '{"ref":"{{input.blockId}}"}',
    },
    status: { method: 'GET', pathTemplate: '/environments/{{provision.externalId}}' },
    teardown: { method: 'DELETE', pathTemplate: '/environments/{{provision.externalId}}' },
    response: {
      urlPath: 'url',
      statusPath: 'state',
      statusMap: [
        { from: 'running', to: 'ready' },
        { from: 'building', to: 'provisioning' },
      ],
      externalIdPath: 'id',
      expiresAtPath: 'expires_at',
      access: { scheme: 'bearer', tokenPath: 'access_token' },
    },
    ...overrides,
  }
}

export interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
}

export interface StubResponse {
  status?: number
  body?: unknown
}

/**
 * Build a `fetch` replacement that records each call and delegates the response
 * to `respond`. Returns `{ fn, calls }`; install with `vi.stubGlobal('fetch', fn)`.
 */
export function recordingFetch(respond: (req: CapturedRequest) => StubResponse) {
  const calls: CapturedRequest[] = []
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    for (const [k, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = value
    }
    const body = typeof init?.body === 'string' ? init.body : null
    const req: CapturedRequest = { method, url, headers, body }
    calls.push(req)
    const res = respond(req)
    return new Response(JSON.stringify(res.body ?? {}), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fn, calls }
}

/** A canned "running" provision/status response with a far-future expiry. */
export function readyEnvBody(expiresAt = Date.now() + 60 * 60 * 1000) {
  return {
    id: 'env-1',
    url: 'https://env-1.envs.test',
    state: 'running',
    expires_at: expiresAt,
    access_token: 'env-access-tok',
  }
}
