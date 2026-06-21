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

  /** Validate a bot token and read the team it belongs to (`auth.test`). */
  async authTest(token: string): Promise<SlackAuthInfo> {
    const data = await this.postJson('auth.test', token, {})
    return {
      teamId: String(data.team_id ?? ''),
      teamName: String(data.team ?? ''),
      botUserId: data.user_id ? String(data.user_id) : null,
      url: data.url ? String(data.url) : null,
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
   * picker. Public + private, excluding archived; a single page (Slack's default
   * limit) is plenty for a dropdown.
   */
  async conversationsList(token: string): Promise<SlackChannel[]> {
    const data = await this.postJson('conversations.list', token, {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 1000,
    })
    const channels = Array.isArray(data.channels) ? data.channels : []
    return channels.map((c) => {
      const channel = c as { id?: string; name?: string; is_private?: boolean }
      return {
        id: String(channel.id ?? ''),
        name: String(channel.name ?? ''),
        isPrivate: Boolean(channel.is_private),
      }
    })
  }

  /** POST a JSON body to a Slack method with a bearer token; throw on `ok:false`. */
  private async postJson(
    method: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<SlackResponse> {
    const res = await this.fetchImpl(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json()) as SlackResponse
    if (!data.ok) throw new SlackApiError(method, data.error ?? 'unknown_error')
    return data
  }
}
