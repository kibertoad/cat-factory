import { SERVICE_CATALOG_CIPHER_INFO } from '@cat-factory/integrations'
import { ORG_SECRET_KEY_ARITY, type OrgSecretSource } from '@cat-factory/kernel'

// The server-side half of mothership secret delegation: what each `OrgSecretSource` actually
// binds to on the mothership's own repository registry.
//
// This table is to `/internal/secrets/unseal` what `REMOTE_PERSISTENCE_METHODS` is to
// `/internal/persistence` and `TELEMETRY_READ_METHODS` is to `/internal/telemetry/read`: a CLOSED,
// own-property-only description of everything a machine-authed caller may reach. It is what makes
// the delegation a lookup rather than an oracle: the node names a source and a row, and the
// mothership decides which repository read answers it, which field of that row holds the sealed
// value, and which HKDF `info` tag opens it. Nothing about the ciphertext comes off the wire.
//
// The `Record<OrgSecretSource, …>` keeps it exhaustive: a source added to the kernel vocabulary
// fails to compile here until it has a binding, so a member can never ship reachable-but-unbound.

/** How one `OrgSecretSource` resolves to a stored envelope on the mothership. */
export interface SealedSecretSourceSpec {
  /** The repository on the mothership's own `container.repositories` registry. */
  repo: string
  /**
   * The read method, invoked as `(workspaceId, ...key)`. It must be a POINT read returning the
   * single owning row: the delegation answers for one secret, and a list read would hand the
   * caller a choice the scope check never saw.
   */
  method: string
  /** The record field holding the sealed envelope. */
  field: string
  /** The HKDF `info` domain-separation tag the envelope was sealed under. */
  info: string
  /** A non-secret label for the audit log: the source's human name, never a value. */
  label: string
}

/**
 * Every source, bound. Each entry admits ONE org credential to a mothership-mode laptop, so the
 * bar for adding one is that a run genuinely needs the PLAINTEXT on the node (it provisions the
 * infrastructure, it probes the monitor), not merely the row.
 */
export const SEALED_SECRET_SOURCES: Record<OrgSecretSource, SealedSecretSourceSpec> = {
  // A provisioned environment's access handle (URLs, kubeconfig, per-env credentials). The node
  // runs the provisioning and the teardown, so it is the process that must open this.
  environment_access: {
    repo: 'environmentRegistryRepository',
    method: 'get',
    field: 'accessCipher',
    info: 'cat-factory:environments',
    label: 'environment access handle',
  },
  // The resolved provision-time field values of the same row, read back on re-provision and on
  // teardown, so it travels with `environment_access` rather than behind a second decision.
  environment_provision_fields: {
    repo: 'environmentRegistryRepository',
    method: 'get',
    field: 'provisionFieldsCipher',
    info: 'cat-factory:environments',
    label: 'environment provision fields',
  },
  // An infra handler's secret bundle, keyed by `(provisionType, manifestId)`. Without it a
  // mothership-mode node can display the connection panel and provision nothing.
  environment_connection: {
    repo: 'environmentConnectionRepository',
    method: 'getByWorkspaceAndType',
    field: 'secretsCipher',
    info: 'cat-factory:environments',
    label: 'environment connection secrets',
  },
  // The release-health vendor credentials the `post-release-health` gate probes with. The gate
  // runs wherever the run runs, which in mothership mode is the laptop.
  observability_connection: {
    repo: 'observabilityConnectionRepository',
    method: 'get',
    field: 'credentials',
    info: 'cat-factory:observability',
    label: 'observability connection credentials',
  },
  // The PagerDuty / incident.io credentials the on-call escalation enriches an incident with,
  // on the same run path as the gate above.
  incident_enrichment_connection: {
    repo: 'incidentEnrichmentConnectionRepository',
    method: 'get',
    field: 'credentials',
    info: 'cat-factory:incident-enrichment',
    label: 'incident enrichment credentials',
  },
  // A workspace's document-source credential bag (a Figma/Confluence/Notion token), keyed by
  // `source`. The node needs the PLAINTEXT rather than the row: the dispatch-time freshness
  // refresh authenticates against the source on the run path, and an import is the node's own
  // outbound call. Until the row carried an envelope at all there was nothing here to name, which
  // is why this integration was the last one parked off the persistence RPC.
  document_source_connection: {
    repo: 'documentConnectionRepository',
    method: 'getByWorkspace',
    field: 'credentialsCipher',
    info: 'cat-factory:documents',
    label: 'document source credentials',
  },
  // The tracker sibling, keyed the same way. Same argument: the `tracker` step files a real
  // ticket from wherever the run runs.
  task_source_connection: {
    repo: 'taskConnectionRepository',
    method: 'getByWorkspace',
    field: 'credentialsCipher',
    info: 'cat-factory:tasks',
    label: 'task source credentials',
  },
  // The developer-portal credential the service-catalog import reads with. Same argument as the
  // two above: the import is an outbound call made from wherever the request landed, so a
  // mothership-mode board's "import now" and its autorefresh both need the plaintext on the node.
  // Workspace-keyed alone, since a workspace holds exactly one connection. The domain tag is
  // IMPORTED rather than spelled again: it must equal what each facade seals the row with, and a
  // divergence between the two would fail as an authentication error against a key nobody can
  // name, so it is one constant rather than three matching literals.
  service_catalog_connection: {
    repo: 'serviceCatalogConnectionRepository',
    method: 'get',
    field: 'credentialsCipher',
    info: SERVICE_CATALOG_CIPHER_INFO,
    label: 'service catalog credentials',
  },
}

/**
 * A resolved binding: the mothership-side spec plus the source's own name and its declared key
 * arity, READ from kernel's `ORG_SECRET_KEY_ARITY` rather than restated here.
 *
 * Arity belongs to the source, not to this table, and both halves of the delegation need it: the
 * node to build a well-formed `key`, this endpoint to reject one that disagrees. Kept in one
 * declaration so the check and the call site cannot drift into disagreeing about a row.
 */
export interface SealedSecretSourceBinding extends SealedSecretSourceSpec {
  source: OrgSecretSource
  /** How many trailing args the read takes after `workspaceId`; the request's `key` must match. */
  keyArity: number
}

/**
 * Look a source up by its wire value. OWN-PROPERTY only, exactly like the persistence allow-list:
 * an attacker-supplied `__proto__` / `constructor` / `toString` must not reach a prototype member
 * and be treated as a spec.
 */
export function sealedSecretSourceSpec(source: unknown): SealedSecretSourceBinding | undefined {
  if (typeof source !== 'string') return undefined
  if (!Object.prototype.hasOwnProperty.call(SEALED_SECRET_SOURCES, source)) return undefined
  const name = source as OrgSecretSource
  return { ...SEALED_SECRET_SOURCES[name], source: name, keyArity: ORG_SECRET_KEY_ARITY[name] }
}
