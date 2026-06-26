import type {
  IncidentEnrichmentConnectionRepository,
  IncidentEnrichmentProvider,
  IncidentMatchQuery,
  IncidentUpdate,
  SecretCipher,
} from '@cat-factory/kernel'
import { CompositeIncidentEnrichmentProvider } from '@cat-factory/kernel'
import { parseIncidentEnrichmentCredentials } from '@cat-factory/contracts'
import { PagerDutyEnrichmentProvider } from '../pagerduty/PagerDutyEnrichmentProvider.js'
import { IncidentIoEnrichmentProvider } from '../incidentio/IncidentIoEnrichmentProvider.js'

/** HKDF domain tag separating the incident-enrichment credential blob from other ciphers. */
export const INCIDENT_ENRICHMENT_CIPHER_INFO = 'cat-factory:incident-enrichment'

export interface WorkspaceIncidentEnrichmentProviderDependencies {
  incidentEnrichmentConnectionRepository: IncidentEnrichmentConnectionRepository
  /** Seals/opens the per-workspace credentials (domain tag 'cat-factory:incident-enrichment'). */
  secretCipher: SecretCipher
}

/**
 * Resolves a workspace's incident-enrichment credentials at enrichment time (instead of
 * a deployment-wide boot-built composite), decrypts the sealed blob, builds the
 * PagerDuty / incident.io providers it configures, and fans the update across them. A
 * workspace with no connection (or no configured provider) is a no-op — best-effort,
 * never throwing into the caller, mirroring `CompositeIncidentEnrichmentProvider`.
 */
export class WorkspaceIncidentEnrichmentProvider implements IncidentEnrichmentProvider {
  private readonly connections: IncidentEnrichmentConnectionRepository
  private readonly cipher: SecretCipher

  constructor(deps: WorkspaceIncidentEnrichmentProviderDependencies) {
    this.connections = deps.incidentEnrichmentConnectionRepository
    this.cipher = deps.secretCipher
  }

  async enrich(query: IncidentMatchQuery, update: IncidentUpdate): Promise<void> {
    const composite = await this.resolve(query.workspaceId)
    if (!composite) return
    await composite.enrich(query, update)
  }

  private async resolve(workspaceId: string): Promise<IncidentEnrichmentProvider | null> {
    const record = await this.connections.get(workspaceId)
    if (!record) return null
    let credentials
    try {
      credentials = parseIncidentEnrichmentCredentials(
        JSON.parse(await this.cipher.decrypt(record.credentials)),
      )
    } catch {
      // A drifted/corrupted row must never break a best-effort enrichment.
      return null
    }
    const providers: IncidentEnrichmentProvider[] = []
    if (credentials.pagerDuty)
      providers.push(new PagerDutyEnrichmentProvider(credentials.pagerDuty))
    if (credentials.incidentIo) {
      providers.push(new IncidentIoEnrichmentProvider(credentials.incidentIo))
    }
    if (providers.length === 0) return null
    return new CompositeIncidentEnrichmentProvider(providers)
  }
}
