import type { Clock } from '@cat-factory/kernel'
import type { TaskConnectionRecord, TaskConnectionRepository } from '@cat-factory/kernel'
import type { TaskSourceSettingsRepository } from '@cat-factory/kernel'
import type { GitHubInstallationRepository } from '@cat-factory/kernel'
import type { TaskCredentials, TaskSourceProvider, TaskSourceRegistry } from '@cat-factory/kernel'
import type {
  TaskConnection,
  TaskSourceDiagnostic,
  TaskSourceKind,
  TaskSourceState,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
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
   * Resolves the workspace's installed GitHub App, used to decide whether the
   * credentialless GitHub Issues source is available (it rides that App). Absent
   * when the GitHub integration isn't wired, in which case GitHub Issues — if its
   * provider is even registered — is reported unavailable.
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
 * A credentialless provider carries no connection to make: there are no credential
 * fields to fill in. Today the only such provider is GitHub Issues, which rides the
 * workspace's installed GitHub App. `connect()` and the import credential resolver
 * use this to skip the connection lookup; it does NOT by itself decide availability
 * (see `listSourceStates`, where the App-presence check is keyed on the GitHub source).
 */
function isCredentialless(provider: TaskSourceProvider): boolean {
  return provider.descriptor.credentialFields.length === 0
}

/**
 * The credentialless source whose availability is the installed GitHub App's
 * presence. Keyed on the source kind (not just "is credentialless") so a future
 * credentialless source with a different out-of-band auth path is forced to add its
 * own availability branch rather than silently inheriting the App check.
 */
function ridesGitHubApp(provider: TaskSourceProvider): boolean {
  return provider.kind === 'github' && isCredentialless(provider)
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
   * presence for credentialed sources, and the installed GitHub App for the
   * credentialless GitHub Issues source.
   */
  async listSourceStates(workspaceId: string): Promise<TaskSourceState[]> {
    const settings = await this.deps.taskSourceSettingsRepository.getByWorkspace(workspaceId)
    const enabledBySource = new Map(settings.map((s) => [s.source, s.enabled]))
    // Resolve availability inputs ONCE up front rather than a per-provider repository read
    // (N+1): the App presence is workspace-wide, and the credentialed connections are one
    // listByWorkspace indexed by source.
    const hasInstallation = this.deps.installations
      ? (await this.deps.installations.getByWorkspace(workspaceId)) !== null
      : false
    const connectedSources = new Set(
      (await this.deps.taskConnectionRepository.listByWorkspace(workspaceId)).map((c) => c.source),
    )
    const states: TaskSourceState[] = []
    for (const provider of this.deps.registry.list()) {
      const available = ridesGitHubApp(provider)
        ? hasInstallation
        : connectedSources.has(provider.kind)
      states.push({
        ...provider.descriptor,
        available,
        // No row ⇒ default enabled, so a source is offered as soon as it's available.
        enabled: enabledBySource.get(provider.kind) ?? true,
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

    if (ridesGitHubApp(provider)) {
      const installed =
        !!this.deps.installations &&
        (await this.deps.installations.getByWorkspace(workspaceId)) !== null
      if (!installed) {
        return {
          source,
          ok: false,
          status: 'not_installed',
          message: `${label} rides this workspace's GitHub App, which isn't installed yet. Install it under Integrations → GitHub, then re-check.`,
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
      // A credentialless source has no connection to make: it rides the workspace's
      // installed GitHub App and is toggled via setEnabled, not connected.
      throw new ValidationError(
        `The ${source} source has no connection to configure; it uses the workspace's installed GitHub App. Enable or disable it instead.`,
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
      credentials,
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

  /** Disconnect a workspace from a source (tombstones the binding). */
  async disconnect(workspaceId: string, source: TaskSourceKind): Promise<void> {
    const record = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) return
    await this.deps.taskConnectionRepository.softDelete(workspaceId, source, this.deps.clock.now())
  }
}
