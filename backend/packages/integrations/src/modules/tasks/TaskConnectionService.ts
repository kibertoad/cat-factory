import type { Clock } from '@cat-factory/kernel'
import type { TaskConnectionRecord, TaskConnectionRepository } from '@cat-factory/kernel'
import type { TaskSourceSettingsRepository } from '@cat-factory/kernel'
import type { GitHubInstallationRepository, VcsProvider } from '@cat-factory/kernel'
import type { TaskCredentials, TaskSourceProvider, TaskSourceRegistry } from '@cat-factory/kernel'
import type {
  TaskConnection,
  TaskSourceDiagnostic,
  TaskSourceKind,
  TaskSourceState,
} from '@cat-factory/kernel'
import {
  ConflictError,
  TRACKER_WEBHOOK_REPLY_ALLOW_KEY,
  TRACKER_WEBHOOK_SECRET_KEY,
  ValidationError,
  trackerWebhookSecret,
} from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import type { LinearOAuthSecret } from '@cat-factory/contracts'
import type { LinearTeam } from './linear.logic.js'

// TaskConnectionService: owns the binding between a cat-factory workspace and an
// external task source. Connecting delegates credential validation to the
// source's provider, then stores the credential bag; the import path resolves it
// to authenticate. Credentials are never exposed back to clients — only the safe
// connection metadata (source, label, timestamp) is.

export interface TaskConnectionServiceDependencies {
  taskConnectionRepository: TaskConnectionRepository
  /** Per-workspace on/off toggle for each source (absent row ⇒ enabled). */
  taskSourceSettingsRepository: TaskSourceSettingsRepository
  registry: TaskSourceRegistry
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /**
   * Resolves the workspace's ONE VCS connection, used to decide whether a credentialless
   * VCS-backed source is available: GitHub Issues rides an installed GitHub App, GitLab Issues
   * rides a per-workspace PAT connection, and the row's own `provider` says which. Absent when
   * no VCS integration is wired, in which case those sources, if their providers are registered
   * at all, are reported unavailable.
   */
  installations?: GitHubInstallationRepository
  /**
   * Resolves the account's Linear OAuth app credentials (the "Connect with Linear"
   * flow), keyed by the account-scope key, or undefined when the account hasn't
   * registered one. Backed by the per-account deployment settings (sealed in the DB,
   * set in the UI) — NOT env — mirroring the Slack OAuth model. Absent ⇒ OAuth
   * onboarding isn't offered (the manual personal-API-key path still works).
   */
  resolveLinearOAuth?: (accountKey: string) => Promise<LinearOAuthSecret | undefined>
}

/**
 * A credentialless provider carries no connection to make: there are no credential fields to
 * fill in, because it authenticates out-of-band (the two VCS-backed sources ride the workspace's
 * VCS connection). `connect()` and the import credential resolver use this to skip the
 * connection lookup; it does NOT by itself decide availability, nor WHICH out-of-band
 * connection is meant (see {@link ridesVcsConnection}).
 */
function isCredentialless(provider: TaskSourceProvider): boolean {
  return provider.descriptor.credentialFields.length === 0
}

/**
 * The VCS connection a credentialless source rides, or null for a source that authenticates
 * some other way. GitHub Issues rides the workspace's installed GitHub App and GitLab Issues
 * rides its per-workspace GitLab connection; both are rows of the same one-per-workspace
 * connection table, told apart by the row's `provider`.
 *
 * Keyed on the source kind (not just "is credentialless") so a future credentialless source
 * with a different out-of-band auth path is forced to add its own availability branch rather
 * than silently inheriting this one. Reading the row's provider (rather than merely its
 * existence) is what stops the two VCS sources standing in for each other: a workspace
 * connected to GitLab would otherwise report GitHub Issues as available, and the import
 * would then resolve an empty App projection.
 */
function ridesVcsConnection(provider: TaskSourceProvider): VcsProvider | null {
  if (!isCredentialless(provider)) return null
  if (provider.kind === 'github') return 'github'
  if (provider.kind === 'gitlab') return 'gitlab'
  return null
}

/**
 * How the connection a VCS-backed source rides is described to an operator, per provider.
 *
 * Split into the thing it rides and the remedy for its absence because the two messages that
 * need this say different halves: the setup check has a MISSING connection to explain, while the
 * connect refusal is explaining that there is nothing to connect HERE (the connection exists, or
 * will, somewhere else). Composing both from one `Record` is what keeps them naming the same
 * integration: the earlier single string was written for the setup check and read as "GitHub App"
 * from the refusal too, which pointed a GitLab operator at an integration their deployment does
 * not run.
 */
interface VcsConnectCopy {
  /** What the source authenticates through, as a noun phrase. */
  rides: string
  /** Why it cannot answer yet and where to fix it, continuing from {@link rides}. */
  absentRemedy: string
}

const VCS_CONNECT_COPY: Record<VcsProvider, VcsConnectCopy> = {
  github: {
    rides: "this workspace's GitHub App",
    absentRemedy: "which isn't installed yet. Install it under Integrations → GitHub",
  },
  gitlab: {
    rides: "this workspace's GitLab connection",
    absentRemedy:
      "which doesn't exist yet. Connect one with a personal access token under Integrations → GitLab",
  },
}

/** A provider that can list Linear teams (only {@link LinearTaskProvider} today). */
interface LinearTeamLister {
  listTeams(credentials: TaskCredentials): Promise<LinearTeam[]>
}

/** Duck-type the optional `listTeams` capability (bundling-safe, unlike `instanceof`). */
function hasListTeams(
  provider: TaskSourceProvider,
): provider is TaskSourceProvider & LinearTeamLister {
  return typeof (provider as Partial<LinearTeamLister>).listTeams === 'function'
}

function toConnection(record: TaskConnectionRecord): TaskConnection {
  return {
    source: record.source,
    label: record.label,
    connectedAt: record.createdAt,
  }
}

export class TaskConnectionService {
  constructor(private readonly deps: TaskConnectionServiceDependencies) {}

  /**
   * Every configured source with the workspace's live state for it (drives the
   * settings + import UI): each source's descriptor plus whether it is available
   * now and whether the workspace has it enabled. Availability is connection
   * presence for a credentialed source, and a matching VCS connection for a
   * VCS-backed one (which provider it needs rides along, so the UI can name the
   * right remedy without a per-source branch of its own).
   */
  async listSourceStates(workspaceId: string): Promise<TaskSourceState[]> {
    const settings = await this.deps.taskSourceSettingsRepository.getByWorkspace(workspaceId)
    const enabledBySource = new Map(settings.map((s) => [s.source, s.enabled]))
    // Resolve availability inputs ONCE up front rather than a per-provider repository read
    // (N+1): the App presence is workspace-wide, and the credentialed connections are one
    // listByWorkspace indexed by source.
    const vcsConnection = this.deps.installations
      ? await this.deps.installations.getByWorkspace(workspaceId)
      : null
    const connectedSources = new Set(
      (await this.deps.taskConnectionRepository.listByWorkspace(workspaceId)).map((c) => c.source),
    )
    const states: TaskSourceState[] = []
    for (const provider of this.deps.registry.list()) {
      const ridesVcs = ridesVcsConnection(provider)
      const available = ridesVcs
        ? vcsConnection?.provider === ridesVcs
        : connectedSources.has(provider.kind)
      states.push({
        ...provider.descriptor,
        available,
        ridesVcsProvider: ridesVcs,
        // No row ⇒ default enabled, so a source is offered as soon as it's available.
        enabled: enabledBySource.get(provider.kind) ?? true,
        // Asked of the provider, not of its descriptor: a source with no predicate search cannot
        // back a recurring intake, and offering it in the schedule form produces a schedule that
        // saves and then never fires.
        supportsIntake: typeof provider.searchIssues === 'function',
        // Asked of the provider too, but DECLARED there rather than derived: the four vendor
        // grammars share no shape to inspect. Absent ⇒ every predicate bites, which is the
        // claim a source makes by saying nothing.
        ignoredIntakePredicates: [...(provider.ignoredIntakePredicates ?? [])],
      })
    }
    return states
  }

  /**
   * Live "check setup" probe for a source: gate on availability first (a GitHub
   * App must be installed, a credentialed source must be connected), then delegate
   * the real authenticate-and-read check to the provider. The result classifies
   * exactly what's wrong (not installed / not connected / auth failed / missing
   * permission / unreachable) with an actionable message, so the panel can guide
   * setup instead of just hiding behind "install integration first".
   */
  async diagnose(workspaceId: string, source: TaskSourceKind): Promise<TaskSourceDiagnostic> {
    const provider = this.deps.registry.get(source)
    if (!provider) {
      return {
        source,
        ok: false,
        status: 'error',
        message: `The ${source} task source isn't configured on this deployment.`,
      }
    }
    const label = provider.descriptor.label

    const ridesVcs = ridesVcsConnection(provider)
    if (ridesVcs) {
      const connection = this.deps.installations
        ? await this.deps.installations.getByWorkspace(workspaceId)
        : null
      if (connection?.provider !== ridesVcs) {
        return {
          source,
          ok: false,
          status: 'not_installed',
          message: `${label} rides ${VCS_CONNECT_COPY[ridesVcs].rides}, ${VCS_CONNECT_COPY[ridesVcs].absentRemedy}, then re-check.`,
        }
      }
      return this.runProviderDiagnose(provider, { workspaceId, credentials: null }, label)
    }

    // Credentialed source (Jira, …): a connection must exist before we can probe.
    const connection = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    if (!connection) {
      return {
        source,
        ok: false,
        status: 'not_connected',
        message: `${label} isn't connected yet. Connect it with an account email and API token, then re-check.`,
      }
    }
    return this.runProviderDiagnose(
      provider,
      { workspaceId, credentials: connection.credentials },
      label,
    )
  }

  /**
   * Run a provider's live `diagnose`, defending against a provider that lacks one
   * (static "ready" verdict — availability was already confirmed above) or one
   * that rejects despite the contract (mapped to a generic error rather than
   * bubbling out of the check endpoint).
   */
  private async runProviderDiagnose(
    provider: TaskSourceProvider,
    input: { workspaceId: string; credentials: TaskCredentials | null },
    label: string,
  ): Promise<TaskSourceDiagnostic> {
    if (!provider.diagnose) {
      return {
        source: provider.kind,
        ok: true,
        status: 'ready',
        message: `${label} is configured.`,
      }
    }
    try {
      return await provider.diagnose(input)
    } catch (err) {
      return {
        source: provider.kind,
        ok: false,
        status: 'error',
        message: `${label} check failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /** The workspace's toggle for a source (defaults to enabled when no row exists). */
  async isEnabled(workspaceId: string, source: TaskSourceKind): Promise<boolean> {
    const row = await this.deps.taskSourceSettingsRepository.get(workspaceId, source)
    return row?.enabled ?? true
  }

  /**
   * Whether a source is USABLE for the workspace right now — the `available && enabled` the
   * settings/import UI offers: available (a connected credentialed source, or the installed
   * GitHub App for the credentialless GitHub Issues source) AND not toggled off. This is the
   * gate a `bug-intake` schedule needs; {@link isEnabled} alone is NOT enough, because it
   * defaults ON for a never-connected source (no settings row), so it would accept intake from
   * a source that has no connection to search. An unknown/unconfigured source ⇒ `false`.
   */
  async isOffered(workspaceId: string, source: TaskSourceKind): Promise<boolean> {
    const state = (await this.listSourceStates(workspaceId)).find((s) => s.source === source)
    return !!state?.available && !!state.enabled
  }

  /** Enable or disable a source for the workspace (the per-workspace toggle). */
  async setEnabled(workspaceId: string, source: TaskSourceKind, enabled: boolean): Promise<void> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    this.requireProvider(source)
    await this.deps.taskSourceSettingsRepository.upsert({ workspaceId, source, enabled })
  }

  /** Resolve a provider for a source or throw if that source isn't configured. */
  private requireProvider(source: TaskSourceKind) {
    const provider = this.deps.registry.get(source)
    if (!provider) throw new ValidationError(`Unknown or unconfigured task source '${source}'`)
    return provider
  }

  /** Connect (or re-connect) a workspace to a task source. */
  async connect(
    workspaceId: string,
    source: TaskSourceKind,
    credentials: Record<string, string>,
  ): Promise<TaskConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    if (isCredentialless(provider)) {
      // A credentialless source has no connection to make: it authenticates out-of-band and is
      // toggled via setEnabled, not connected. WHERE it authenticates is the provider's own
      // answer, so the refusal names the integration this source actually rides. A credentialless
      // source riding neither VCS connection (a deployment-registered one authenticating some
      // other way) says only what is true: there are no credentials to configure here.
      const ridesVcs = ridesVcsConnection(provider)
      throw new ValidationError(
        ridesVcs
          ? `The ${source} source has no connection to configure; it rides ${VCS_CONNECT_COPY[ridesVcs].rides}. Enable or disable it instead.`
          : `The ${source} source has no credentials to configure. Enable or disable it instead.`,
      )
    }
    const normalized = provider.normalizeConnection(credentials)
    return this.store(workspaceId, source, normalized.credentials, normalized.label)
  }

  /**
   * Complete the Linear OAuth flow: persist the exchanged access token as the
   * workspace's Linear connection (a `{ token }` credential bag, used as a `Bearer`
   * token by the shared client). The token exchange itself happens in the server's
   * OAuth callback (which holds the OAuth client + secret); this only stores the
   * result, so the integrations package stays free of OAuth config.
   */
  async connectLinearViaOAuth(workspaceId: string, token: string): Promise<TaskConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    this.requireProvider('linear')
    return this.store(workspaceId, 'linear', { token }, 'Linear workspace')
  }

  /**
   * List the workspace's Linear teams, for the ticket-filing team picker. Linear-
   * specific, so it duck-types the provider's `listTeams` rather than widening the
   * generic port (and `instanceof` is unreliable once the class is bundled across
   * module boundaries). Throws when Linear isn't connected; returns [] if the wired
   * provider can't list teams.
   */
  async listLinearTeams(workspaceId: string): Promise<LinearTeam[]> {
    const provider = this.requireProvider('linear')
    const connection = await this.deps.taskConnectionRepository.getByWorkspace(
      workspaceId,
      'linear',
    )
    if (!connection)
      throw new ConflictError(`Workspace '${workspaceId}' is not connected to linear`)
    if (!hasListTeams(provider)) return []
    return provider.listTeams(connection.credentials)
  }

  /**
   * Resolve the account's Linear OAuth app credentials for a workspace (the per-account
   * deployment setting), or undefined when none is configured. Keyed by the account-scope
   * key (the workspace's account id, else the workspace id) — mirroring the Slack model — so
   * an org registers ONE Linear OAuth app shared by its workspaces.
   */
  async resolveLinearOAuthConfig(workspaceId: string): Promise<LinearOAuthSecret | undefined> {
    if (!this.deps.resolveLinearOAuth) return undefined
    return this.deps.resolveLinearOAuth(await this.resolveAccountKey(workspaceId))
  }

  /** The per-account scope key for a workspace (account id, else the workspace id). */
  private async resolveAccountKey(workspaceId: string): Promise<string> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    return (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? workspaceId
  }

  /** Build + upsert a connection record (shared by the manual connect + OAuth paths). */
  private async store(
    workspaceId: string,
    source: TaskSourceKind,
    credentials: TaskCredentials,
    label: string,
  ): Promise<TaskConnection> {
    const existing = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    const record: TaskConnectionRecord = {
      workspaceId,
      source,
      // Carry the PLATFORM-owned keys across a re-connect. The bag is replaced wholesale (a
      // reconnect is "here are my credentials now"), and a provider's `normalizeConnection`
      // legitimately returns only the VENDOR credentials it validated — so without this, rotating
      // a Jira API token would silently drop the inbound webhook secret and every subsequent
      // delivery would 503 with nothing to point at the cause. Preserved HERE rather than in each
      // provider so no provider can forget, and so a new platform-owned key is a one-line change.
      credentials: { ...preservedPlatformCredentials(existing?.credentials), ...credentials },
      label,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.taskConnectionRepository.upsert(record)
    return toConnection(record)
  }

  /** The workspace's current connection for a source, or null if not connected. */
  async getConnection(workspaceId: string, source: TaskSourceKind): Promise<TaskConnection | null> {
    const record = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    return record ? toConnection(record) : null
  }

  /** Every live connection the workspace holds, across sources. */
  async listConnections(workspaceId: string): Promise<TaskConnection[]> {
    const records = await this.deps.taskConnectionRepository.listByWorkspace(workspaceId)
    return records.map(toConnection)
  }

  /** Resolve the live connection (with credentials) or throw if not connected. */
  async requireConnection(
    workspaceId: string,
    source: TaskSourceKind,
  ): Promise<TaskConnectionRecord> {
    const record = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) {
      throw new ConflictError(`Workspace '${workspaceId}' is not connected to ${source}`)
    }
    return record
  }

  /**
   * The provider serving a source on this deployment, or undefined when it isn't registered.
   * Exposed so the shared webhook receiver can reach a source's `webhook` adapter without a second
   * registry of its own — the connection service is already the one thing that holds both the
   * registry and the stored credentials a delivery is verified against.
   */
  providerFor(source: TaskSourceKind): TaskSourceProvider | undefined {
    return this.deps.registry.get(source)
  }

  /**
   * The workspace's stored connection RECORD (credentials included), or null when not connected.
   *
   * Distinct from {@link getConnection}, which deliberately projects credentials away for client
   * responses. This is for server-internal callers that need the bag itself — today the webhook
   * receiver, reading the inbound secret.
   */
  getConnectionRecord(
    workspaceId: string,
    source: TaskSourceKind,
  ): Promise<TaskConnectionRecord | null> {
    return this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
  }

  /** The connection's inbound-webhook state, safe to read back at any time (never the secret). */
  async getWebhookState(
    workspaceId: string,
    source: TaskSourceKind,
  ): Promise<TaskSourceWebhookState> {
    const record = await this.getConnectionRecord(workspaceId, source)
    return {
      source,
      supported: this.deps.registry.get(source)?.webhook != null,
      configured: trackerWebhookSecret(record?.credentials) !== '',
      deliveryPath: trackerWebhookPath(workspaceId, source),
      replyAllow: record?.credentials?.[TRACKER_WEBHOOK_REPLY_ALLOW_KEY] ?? '',
    }
  }

  /**
   * Mint (or ROTATE) the connection's inbound-webhook secret, returning it exactly once.
   *
   * Rotation is destructive by design: the previous secret stops verifying the instant this
   * returns, so a delivery signed with it is rejected rather than accepted during a grace window.
   * Backwards compatibility is a non-goal here and a webhook secret with two live values is a
   * webhook secret an attacker only has to steal once.
   */
  async mintWebhookSecret(
    workspaceId: string,
    source: TaskSourceKind,
    input: { replyAllow?: string } = {},
  ): Promise<TaskSourceWebhookState & { secret: string }> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.deps.registry.get(source)
    if (!provider?.webhook) {
      throw new ValidationError(`${source} does not accept inbound webhooks on this deployment`)
    }
    const record = await this.requireConnection(workspaceId, source)
    const secret = generateWebhookSecret()
    const credentials: TaskCredentials = {
      ...record.credentials,
      [TRACKER_WEBHOOK_SECRET_KEY]: secret,
      ...(input.replyAllow !== undefined
        ? { [TRACKER_WEBHOOK_REPLY_ALLOW_KEY]: input.replyAllow.trim() }
        : {}),
    }
    await this.deps.taskConnectionRepository.upsert({ ...record, credentials })
    return {
      source,
      supported: true,
      configured: true,
      deliveryPath: trackerWebhookPath(workspaceId, source),
      replyAllow: credentials[TRACKER_WEBHOOK_REPLY_ALLOW_KEY] ?? '',
      secret,
    }
  }

  /**
   * Edit the reply allow-list, leaving the webhook secret untouched.
   *
   * Deliberately NOT folded into {@link mintWebhookSecret}: that call rotates, and rotation is
   * destructive the instant it returns. Tightening the allow-list is precisely what an operator
   * does when a tracker turns out to be more public than they thought, and answering that with a
   * silently rotated secret would take deliveries down until they re-pasted it into the vendor —
   * a security control that costs an outage is a security control people avoid using.
   */
  async updateWebhookReplyAllow(
    workspaceId: string,
    source: TaskSourceKind,
    replyAllow: string,
  ): Promise<TaskSourceWebhookState> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const record = await this.requireConnection(workspaceId, source)
    const credentials: TaskCredentials = {
      ...record.credentials,
      [TRACKER_WEBHOOK_REPLY_ALLOW_KEY]: replyAllow.trim(),
    }
    await this.deps.taskConnectionRepository.upsert({ ...record, credentials })
    return {
      source,
      supported: this.deps.registry.get(source)?.webhook != null,
      configured: trackerWebhookSecret(credentials) !== '',
      deliveryPath: trackerWebhookPath(workspaceId, source),
      replyAllow: credentials[TRACKER_WEBHOOK_REPLY_ALLOW_KEY] ?? '',
    }
  }

  /**
   * Clear the inbound-webhook secret, so deliveries stop being accepted (they 503 at the receiver,
   * which is the honest answer: the operator turned this off). The connection itself is untouched
   * — polling intake and imports keep working exactly as before.
   */
  async clearWebhookSecret(workspaceId: string, source: TaskSourceKind): Promise<void> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const record = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) return
    const credentials = { ...record.credentials }
    delete credentials[TRACKER_WEBHOOK_SECRET_KEY]
    await this.deps.taskConnectionRepository.upsert({ ...record, credentials })
  }

  /** Disconnect a workspace from a source (tombstones the binding). */
  async disconnect(workspaceId: string, source: TaskSourceKind): Promise<void> {
    const record = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) return
    await this.deps.taskConnectionRepository.softDelete(workspaceId, source, this.deps.clock.now())
  }
}

/** The inbound-webhook state of one connection (the secret itself is never part of it). */
export interface TaskSourceWebhookState {
  source: TaskSourceKind
  supported: boolean
  configured: boolean
  deliveryPath: string
  replyAllow: string
}

/**
 * Where a tracker should POST its deliveries, relative to the deployment's public base URL.
 *
 * Built here rather than in the controller so the string an operator PASTES and the route the
 * receiver SERVES have one definition — a mismatch between them fails silently, as deliveries that
 * simply never arrive.
 */
export function trackerWebhookPath(workspaceId: string, source: TaskSourceKind): string {
  return `/webhooks/tasks/${source}/${workspaceId}`
}

/**
 * A fresh inbound-webhook secret: 32 bytes of CSPRNG entropy, hex-encoded.
 *
 * `crypto.getRandomValues` (not `Math.random`) because this value is the ONLY thing standing
 * between an anonymous POST and a run-driving command; it is a global on both workerd and Node.
 * Hex rather than base64url so it survives being pasted into every vendor's webhook form without
 * anyone wondering whether a `-` or `_` was part of it.
 */
function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * The credential-bag keys the PLATFORM owns rather than the vendor — today the inbound-webhook
 * secret and its reply allow-list. They are configured through their own endpoints, never sent to
 * the vendor, and must survive a credential rotation.
 *
 * Note the merge order at the call site: preserved keys come FIRST, so an explicit value in the
 * incoming bag still wins. That matters for the mint path, which writes the secret through the
 * same store.
 */
function preservedPlatformCredentials(existing: TaskCredentials | undefined): TaskCredentials {
  if (!existing) return {}
  const preserved: TaskCredentials = {}
  for (const key of [TRACKER_WEBHOOK_SECRET_KEY, TRACKER_WEBHOOK_REPLY_ALLOW_KEY]) {
    const value = existing[key]
    if (value !== undefined) preserved[key] = value
  }
  return preserved
}
