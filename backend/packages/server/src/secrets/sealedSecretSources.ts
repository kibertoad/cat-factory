import { ORG_SECRET_SOURCES, type OrgSecretSource } from '@cat-factory/kernel'

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
  /**
   * How many trailing identifier args the read takes after `workspaceId`. The request's `key` must
   * supply EXACTLY this many. Arity is part of the shape because the args are spread into the
   * call, so a short list would read a different row than the caller named (and a long one would
   * pass an argument the port never declared).
   */
  keyArity: number
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
    keyArity: 1,
    field: 'accessCipher',
    info: 'cat-factory:environments',
    label: 'environment access handle',
  },
  // The resolved provision-time field values of the same row, read back on re-provision and on
  // teardown, so it travels with `environment_access` rather than behind a second decision.
  environment_provision_fields: {
    repo: 'environmentRegistryRepository',
    method: 'get',
    keyArity: 1,
    field: 'provisionFieldsCipher',
    info: 'cat-factory:environments',
    label: 'environment provision fields',
  },
  // An infra handler's secret bundle, keyed by `(provisionType, manifestId)`. Without it a
  // mothership-mode node can display the connection panel and provision nothing.
  environment_connection: {
    repo: 'environmentConnectionRepository',
    method: 'getByWorkspaceAndType',
    keyArity: 2,
    field: 'secretsCipher',
    info: 'cat-factory:environments',
    label: 'environment connection secrets',
  },
  // The release-health vendor credentials the `post-release-health` gate probes with. The gate
  // runs wherever the run runs, which in mothership mode is the laptop.
  observability_connection: {
    repo: 'observabilityConnectionRepository',
    method: 'get',
    keyArity: 0,
    field: 'credentials',
    info: 'cat-factory:observability',
    label: 'observability connection credentials',
  },
  // The PagerDuty / incident.io credentials the on-call escalation enriches an incident with,
  // on the same run path as the gate above.
  incident_enrichment_connection: {
    repo: 'incidentEnrichmentConnectionRepository',
    method: 'get',
    keyArity: 0,
    field: 'credentials',
    info: 'cat-factory:incident-enrichment',
    label: 'incident enrichment credentials',
  },
}

/**
 * Look a source up by its wire value. OWN-PROPERTY only, exactly like the persistence allow-list:
 * an attacker-supplied `__proto__` / `constructor` / `toString` must not reach a prototype member
 * and be treated as a spec.
 */
export function sealedSecretSourceSpec(source: unknown): SealedSecretSourceSpec | undefined {
  if (typeof source !== 'string') return undefined
  if (!Object.prototype.hasOwnProperty.call(SEALED_SECRET_SOURCES, source)) return undefined
  return SEALED_SECRET_SOURCES[source as OrgSecretSource]
}

/** The declared vocabulary, for tests and for the boot-time completeness assertions. */
export const SEALED_SECRET_SOURCE_NAMES: readonly OrgSecretSource[] = ORG_SECRET_SOURCES
