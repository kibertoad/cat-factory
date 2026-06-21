import type { SlackChannel } from '@cat-factory/kernel'

// A thin, runtime-neutral wrapper over the Slack Web API (plain `fetch`, no SDK),
// so it runs identically in a Workers isolate and under Node. Only the handful of
// methods the integration needs: validate a bot token, exchange an OAuth code,
// post a message, and list channels for the routing picker.

/** Result of `auth.test` — the installed team + the bot user the token posts as. */
export interface SlackAuthInfo {
  teamId: string
  teamName: string
  botUserId: string | null
  url: string | null
  /** OAuth scopes granted to the token, read from the `x-oauth-scopes` header. */
  scopes: string[]
}

/** Result of an `oauth.v2.access` exchange. */
export interface SlackOAuthResult {
  accessToken: string
  teamId: string
  teamName: string
  botUserId: string | null
  scopes: string[]
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly slackError: string,
  ) {
    super(`Slack ${method} failed: ${slackError}`)
    this.name = 'SlackApiError'
  }
}

type FetchLike = typeof fetch

export interface SlackApiClientOptions {
  /** Override fetch (tests); defaults to the global. */
  fetchImpl?: FetchLike
  /** Slack API base; defaults to the public endpoint. */
  apiBase?: string
}

interface SlackResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export class SlackApiClient {
  private readonly fetchImpl: FetchLike
  private readonly apiBase: string

  constructor(options: SlackApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.apiBase = (options.apiBase ?? 'https://slack.com/api').replace(/\/+$/, '')
  }

  /**
   * Validate a bot token and read the team it belongs to (`auth.test`). The granted
   * OAuth scopes aren't in the body — Slack returns them in the `x-oauth-scopes`
   * response header on any Web API call — so we read them here too, which lets the
   * manual-token onboarding path capture real scopes (not an empty list).
   */
  async authTest(token: string): Promise<SlackAuthInfo> {
    const res = await this.request('auth.test', token, {})
    const data = (await res.json()) as SlackResponse
    if (!data.ok) throw new SlackApiError('auth.test', data.error ?? 'unknown_error')
    return {
      teamId: String(data.team_id ?? ''),
      teamName: String(data.team ?? ''),
      botUserId: data.user_id ? String(data.user_id) : null,
      url: data.url ? String(data.url) : null,
      scopes: parseScopeHeader(res.headers.get('x-oauth-scopes')),
    }
  }

  /**
   * Exchange an OAuth authorization `code` for a bot token (`oauth.v2.access`).
   * Posted as form-encoded with the app's client credentials.
   */
  async oauthAccess(input: {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
  }): Promise<SlackOAuthResult> {
    const form = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    })
    const res = await this.fetchImpl(`${this.apiBase}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    const data = (await res.json()) as SlackResponse
    if (!data.ok) throw new SlackApiError('oauth.v2.access', data.error ?? 'unknown_error')
    const team = (data.team ?? {}) as { id?: string; name?: string }
    return {
      accessToken: String(data.access_token ?? ''),
      teamId: String(team.id ?? ''),
      teamName: String(team.name ?? ''),
      botUserId: data.bot_user_id ? String(data.bot_user_id) : null,
      scopes: typeof data.scope === 'string' && data.scope ? data.scope.split(',') : [],
    }
  }

  /** Post a message (`chat.postMessage`). `body` is a rendered message payload. */
  async chatPostMessage(token: string, body: Record<string, unknown>): Promise<void> {
    await this.postJson('chat.postMessage', token, body)
  }

  /**
   * List the channels the bot can see (`conversations.list`), for the routing
   * picker. Public + private, excluding archived. Follows the cursor so a workspace
   * with more than one page of channels (>1000) isn't silently truncated, with a
   * page cap as a safety bound against an unbounded loop.
   */
  async conversationsList(token: string): Promise<SlackChannel[]> {
    const result: SlackChannel[] = []
    let cursor: string | undefined
    const MAX_PAGES = 20
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.postJson('conversations.list', token, {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      })
      const channels = Array.isArray(data.channels) ? data.channels : []
      for (const c of channels) {
        const channel = c as { id?: string; name?: string; is_private?: boolean }
        result.push({
          id: String(channel.id ?? ''),
          name: String(channel.name ?? ''),
          isPrivate: Boolean(channel.is_private),
        })
      }
      const meta = data.response_metadata as { next_cursor?: string } | undefined
      const next = meta?.next_cursor
      if (!next) break
      cursor = next
    }
    return result
  }

  /** POST a JSON body to a Slack method with a bearer token (raw response). */
  private request(method: string, token: string, body: Record<string, unknown>): Promise<Response> {
    return this.fetchImpl(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    })
  }

  /** POST a JSON body to a Slack method with a bearer token; throw on `ok:false`. */
  private async postJson(
    method: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<SlackResponse> {
    const res = await this.request(method, token, body)
    const data = (await res.json()) as SlackResponse
    if (!data.ok) throw new SlackApiError(method, data.error ?? 'unknown_error')
    return data
  }
}

/** Parse Slack's comma-separated `x-oauth-scopes` header into a trimmed list. */
function parseScopeHeader(header: string | null): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
