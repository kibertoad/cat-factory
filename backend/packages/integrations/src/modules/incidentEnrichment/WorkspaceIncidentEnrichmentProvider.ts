import type {
  IncidentEnrichmentConnectionRepository,
  IncidentEnrichmentProvider,
  IncidentMatchQuery,
  IncidentUpdate,
  Logger,
  OrgSecretCipher,
  SecretCipher,
  SecretDelegate,
} from '@cat-factory/kernel'
import {
  CompositeIncidentEnrichmentProvider,
  createOrgSecretCipher,
  describeError,
  noopLogger,
} from '@cat-factory/kernel'
import { parseIncidentEnrichmentCredentials } from '@cat-factory/contracts'
import { PagerDutyEnrichmentProvider } from '../pagerduty/PagerDutyEnrichmentProvider.js'
import { IncidentIoEnrichmentProvider } from '../incidentio/IncidentIoEnrichmentProvider.js'

/** HKDF domain tag separating the incident-enrichment credential blob from other ciphers. */
export const INCIDENT_ENRICHMENT_CIPHER_INFO = 'cat-factory:incident-enrichment'

export interface WorkspaceIncidentEnrichmentProviderDependencies {
  incidentEnrichmentConnectionRepository: IncidentEnrichmentConnectionRepository
  /** Seals/opens the per-workspace credentials (domain tag 'cat-factory:incident-enrichment'). */
  secretCipher: SecretCipher
  /**
   * Present ONLY on a mothership-mode node, where the row was sealed under the MOTHERSHIP's key.
   * The on-call escalation runs wherever the RUN runs, so without it the enrichment no-ops there
   * (reported through {@link logger}, never silently: see the catch in `resolve`).
   */
  secretDelegate?: SecretDelegate
  /**
   * Where a dropped enrichment is reported. Absent ⇒ `noopLogger`, so the provider stays
   * unit-testable standalone; every composition root wires the real one.
   */
  logger?: Logger
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
  private readonly orgSecrets: OrgSecretCipher
  private readonly log: Logger

  constructor(deps: WorkspaceIncidentEnrichmentProviderDependencies) {
    this.connections = deps.incidentEnrichmentConnectionRepository
    this.log = deps.logger ?? noopLogger
    this.orgSecrets = createOrgSecretCipher({
      cipher: deps.secretCipher,
      ...(deps.secretDelegate ? { delegate: deps.secretDelegate } : {}),
    })
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
        JSON.parse(
          await this.orgSecrets.decryptFor(
            { source: 'incident_enrichment_connection', workspaceId },
            record.credentials,
          ),
        ),
      )
    } catch (error) {
      // A drifted/corrupted row must never break a best-effort enrichment, so the swallow stays.
      // What does NOT stay is its silence. Since the secrets-delegation slice this open can also
      // fail because the MOTHERSHIP is unreachable or refused the row, and a dropped enrichment is
      // indistinguishable, to everyone downstream, from a workspace that configured none: the
      // on-call escalation just never annotates the incident. That is exactly the disposition the
      // `SecretDelegate` port forbids its callers from inventing, so the drop is stated here
      // instead, with the cause attached.
      this.log.warn('incident enrichment: could not open the connection credentials', {
        workspaceId,
        ...describeError(error),
      })
      return null
    }
    const providers: IncidentEnrichmentProvider[] = []
    if (credentials.pagerDuty)
      providers.push(new PagerDutyEnrichmentProvider(credentials.pagerDuty))
    if (credentials.incidentIo) {
      providers.push(new IncidentIoEnrichmentProvider(credentials.incidentIo))
    }
    if (providers.length === 0) return null
    return new CompositeIncidentEnrichmentProvider(providers, this.log)
  }
}
