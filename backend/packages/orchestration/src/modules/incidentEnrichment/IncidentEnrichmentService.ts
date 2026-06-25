import type {
  Clock,
  IncidentEnrichmentConnectionRepository,
  SecretCipher,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ConflictError, requireWorkspace } from '@cat-factory/kernel'
import type {
  IncidentEnrichmentCredentials,
  IncidentEnrichmentView,
  UpsertIncidentEnrichmentInput,
} from '@cat-factory/contracts'
import {
  incidentEnrichmentSummary,
  parseIncidentEnrichmentCredentials,
} from '@cat-factory/contracts'

export interface IncidentEnrichmentServiceDependencies {
  incidentEnrichmentConnectionRepository: IncidentEnrichmentConnectionRepository
  /** Seals the credentials at rest (domain tag 'cat-factory:incident-enrichment'). */
  incidentEnrichmentSecretCipher: SecretCipher
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

/**
 * Manages a workspace's incident-enrichment connection (PagerDuty + incident.io) —
 * both vendors sealed at rest as ONE JSON blob, never read back. {@link setConnection}
 * MERGES the supplied provider group(s) over the stored blob (so a workspace can edit
 * one vendor without re-entering the other), then re-seals; {@link deleteConnection}
 * clears the whole connection. Reads return a redacted view (presence only).
 */
export class IncidentEnrichmentService {
  private readonly connections: IncidentEnrichmentConnectionRepository
  private readonly cipher: SecretCipher
  private readonly workspaceRepository: WorkspaceRepository
  private readonly clock: Clock

  constructor(deps: IncidentEnrichmentServiceDependencies) {
    this.connections = deps.incidentEnrichmentConnectionRepository
    this.cipher = deps.incidentEnrichmentSecretCipher
    this.workspaceRepository = deps.workspaceRepository
    this.clock = deps.clock
  }

  /** The workspace's connection, redacted (presence flags only — never the tokens). */
  async getConnection(workspaceId: string): Promise<IncidentEnrichmentView> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const record = await this.connections.get(workspaceId)
    if (!record) return { connected: false, summary: null }
    return { connected: true, summary: parseSummary(record.summary) }
  }

  /** Merge the supplied provider group(s) into the workspace's sealed credentials. */
  async setConnection(
    workspaceId: string,
    input: UpsertIncidentEnrichmentInput,
  ): Promise<IncidentEnrichmentView> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const now = this.clock.now()
    const existing = await this.connections.get(workspaceId)
    // Decrypt the stored blob STRICTLY before re-sealing: if it can't be opened (e.g. the
    // encryption key changed), refuse rather than silently dropping the un-edited group on
    // the next partial write. The operator clears + re-enters to reset.
    const current = existing ? await this.openCredentials(existing.credentials) : {}
    // Three-state merge per provider group: omitted ⇒ preserve, null ⇒ clear, value ⇒ set.
    const merged: IncidentEnrichmentCredentials = { ...current }
    for (const key of ['pagerDuty', 'incidentIo'] as const) {
      const patch = input[key]
      if (patch === undefined) continue
      if (patch === null) delete merged[key]
      else merged[key] = patch as never
    }
    const summary = incidentEnrichmentSummary(merged)
    const credentials = await this.cipher.encrypt(JSON.stringify(merged))
    await this.connections.upsert({
      workspaceId,
      credentials,
      summary: JSON.stringify(summary),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    return { connected: true, summary }
  }

  async deleteConnection(workspaceId: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.connections.delete(workspaceId)
  }

  /**
   * Decrypt + parse the stored credentials blob for a re-seal. Throws (as a clear
   * {@link ConflictError}) when the blob can't be opened, so {@link setConnection} refuses
   * to overwrite rather than wiping the un-edited provider group — see the call site.
   */
  private async openCredentials(sealed: string): Promise<IncidentEnrichmentCredentials> {
    try {
      return parseIncidentEnrichmentCredentials(JSON.parse(await this.cipher.decrypt(sealed)))
    } catch {
      throw new ConflictError(
        'The stored incident-enrichment credentials could not be decrypted (the encryption ' +
          'key may have changed). Delete the connection and re-enter the credentials to reset.',
      )
    }
  }
}

/** Parse the stored non-secret summary JSON, tolerating a malformed/empty value. */
function parseSummary(raw: string): IncidentEnrichmentView['summary'] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      return { pagerDuty: Boolean(obj.pagerDuty), incidentIo: Boolean(obj.incidentIo) }
    }
  } catch {
    // fall through
  }
  return null
}
