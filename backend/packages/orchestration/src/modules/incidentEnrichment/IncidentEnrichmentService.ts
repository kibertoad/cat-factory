import type {
  Clock,
  IncidentEnrichmentConnectionRepository,
  SecretCipher,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
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
    const current = existing ? await this.openCredentials(existing.credentials) : {}
    // Provided groups overlay the stored ones; omitted groups are preserved.
    const merged: IncidentEnrichmentCredentials = {
      ...current,
      ...(input.pagerDuty ? { pagerDuty: input.pagerDuty } : {}),
      ...(input.incidentIo ? { incidentIo: input.incidentIo } : {}),
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

  private async openCredentials(sealed: string): Promise<IncidentEnrichmentCredentials> {
    try {
      return parseIncidentEnrichmentCredentials(JSON.parse(await this.cipher.decrypt(sealed)))
    } catch {
      return {}
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
