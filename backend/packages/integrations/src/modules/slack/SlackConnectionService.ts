import type { Clock, SecretCipher, WorkspaceRepository } from '@cat-factory/kernel'
import type {
  SlackChannel,
  SlackConnection,
  SlackConnectionRecord,
  SlackConnectionRepository,
} from '@cat-factory/kernel'
import { ConflictError, requireWorkspace } from '@cat-factory/kernel'
import { SlackApiClient } from './SlackApiClient.js'

// SlackConnectionService: owns the binding between a cat-factory ACCOUNT and an
// installed Slack workspace (team) + its bot token. Mirrors
// GitHubInstallationService (account-scoped, cross-account claim guard) and
// RunnerPoolConnectionService (the secret is encrypted at rest, never returned).
//
// The connection is keyed by an "account scope key": the workspace's account id
// when it has one, else the workspace id itself (the auth-disabled / local-dev
// path has no account — there Slack degrades to per-workspace, which is correct
// for a single-tenant dev box). Production multi-tenant deployments always have
// accounts, so an org installs Slack once and every workspace in it shares it.

export interface SlackConnectionServiceDependencies {
  slackConnectionRepository: SlackConnectionRepository
  workspaceRepository: WorkspaceRepository
  secretCipher: SecretCipher
  clock: Clock
  /** Slack Web API client; defaults to a fetch-backed one. */
  slackClient?: SlackApiClient
  /** OAuth app credentials, when the deployment registered a Slack app. */
  oauth?: { clientId: string; clientSecret: string; redirectUrl: string }
}

function toConnection(record: SlackConnectionRecord): SlackConnection {
  let scopes: string[] = []
  if (record.scopesJson) {
    try {
      const parsed = JSON.parse(record.scopesJson)
      if (Array.isArray(parsed)) scopes = parsed as string[]
    } catch {
      scopes = []
    }
  }
  return {
    teamId: record.teamId,
    teamName: record.teamName,
    teamIconUrl: record.teamIconUrl,
    botUserId: record.botUserId,
    scopes,
    connectedAt: record.createdAt,
  }
}

export class SlackConnectionService {
  private readonly slack: SlackApiClient

  constructor(private readonly deps: SlackConnectionServiceDependencies) {
    this.slack = deps.slackClient ?? new SlackApiClient()
  }

  /** Whether OAuth onboarding is available (the app credentials were configured). */
  get oauthEnabled(): boolean {
    return Boolean(this.deps.oauth)
  }

  /** Build the "Add to Slack" authorize URL, embedding a signed `state`. */
  buildInstallUrl(state: string, scopes: string[]): string {
    if (!this.deps.oauth) throw new ConflictError('Slack OAuth is not configured')
    const params = new URLSearchParams({
      client_id: this.deps.oauth.clientId,
      scope: scopes.join(','),
      redirect_uri: this.deps.oauth.redirectUrl,
      state,
    })
    return `https://slack.com/oauth/v2/authorize?${params.toString()}`
  }

  /** Connect by pasting a bot token (the always-available path). */
  async connectWithToken(workspaceId: string, token: string): Promise<SlackConnection> {
    const accountKey = await this.resolveAccountKey(workspaceId)
    const info = await this.slack.authTest(token)
    return this.store(accountKey, {
      teamId: info.teamId,
      teamName: info.teamName,
      teamIconUrl: null,
      botUserId: info.botUserId,
      scopes: info.scopes,
      token,
    })
  }

  /** Connect by exchanging an OAuth authorization code for a bot token. */
  async connectViaOAuth(workspaceId: string, code: string): Promise<SlackConnection> {
    if (!this.deps.oauth) throw new ConflictError('Slack OAuth is not configured')
    const accountKey = await this.resolveAccountKey(workspaceId)
    const result = await this.slack.oauthAccess({
      clientId: this.deps.oauth.clientId,
      clientSecret: this.deps.oauth.clientSecret,
      code,
      redirectUri: this.deps.oauth.redirectUrl,
    })
    return this.store(accountKey, {
      teamId: result.teamId,
      teamName: result.teamName,
      teamIconUrl: null,
      botUserId: result.botUserId,
      scopes: result.scopes,
      token: result.accessToken,
    })
  }

  /** The account's current connection (safe metadata), or null. */
  async getConnection(workspaceId: string): Promise<SlackConnection | null> {
    const accountKey = await this.resolveAccountKey(workspaceId)
    const record = await this.deps.slackConnectionRepository.getByAccount(accountKey)
    if (!record || record.deletedAt) return null
    return toConnection(record)
  }

  /** Disconnect the account's Slack (tombstones the binding). */
  async disconnect(workspaceId: string): Promise<void> {
    const accountKey = await this.resolveAccountKey(workspaceId)
    const record = await this.deps.slackConnectionRepository.getByAccount(accountKey)
    if (!record || record.deletedAt) return
    await this.deps.slackConnectionRepository.softDelete(accountKey, this.deps.clock.now())
  }

  /** List channels the bot can post to, for the routing picker; [] when not connected. */
  async listChannels(workspaceId: string): Promise<SlackChannel[]> {
    const accountKey = await this.resolveAccountKey(workspaceId)
    const record = await this.deps.slackConnectionRepository.getByAccount(accountKey)
    if (!record || record.deletedAt) return []
    const token = await this.deps.secretCipher.decrypt(record.tokenCipher)
    return this.slack.conversationsList(token)
  }

  /** Encrypt the token + persist the connection, guarding against a cross-account claim. */
  private async store(
    accountKey: string,
    info: {
      teamId: string
      teamName: string
      teamIconUrl: string | null
      botUserId: string | null
      scopes: string[]
      token: string
    },
  ): Promise<SlackConnection> {
    // Guard: a Slack team already bound to a DIFFERENT account cannot be claimed
    // (account-takeover prevention); reconnecting the SAME account is fine. We
    // ignore the other binding's tombstone — the app is still installed on Slack.
    const claimed = await this.deps.slackConnectionRepository.getByTeam(info.teamId)
    if (claimed && claimed.accountId !== accountKey) {
      throw new ConflictError(`Slack team ${info.teamId} is already connected to another account`)
    }
    const existing = await this.deps.slackConnectionRepository.getByAccount(accountKey)
    const tokenCipher = await this.deps.secretCipher.encrypt(info.token)
    const record: SlackConnectionRecord = {
      accountId: accountKey,
      teamId: info.teamId,
      teamName: info.teamName,
      teamIconUrl: info.teamIconUrl,
      botUserId: info.botUserId,
      scopesJson: info.scopes.length ? JSON.stringify(info.scopes) : null,
      tokenCipher,
      createdAt: existing && !existing.deletedAt ? existing.createdAt : this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.slackConnectionRepository.upsert(record)
    return toConnection(record)
  }

  /** The per-account scope key for a workspace (account id, else the workspace id). */
  private async resolveAccountKey(workspaceId: string): Promise<string> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    return (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? workspaceId
  }
}
