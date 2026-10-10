import type {
  ApiContractFormat,
  ServiceCatalogCoverage,
  ServiceCatalogProvider,
} from '@cat-factory/contracts'
import type { ConnectionTestResult } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Port for reading an organisation's DEVELOPER PORTAL (Backstage today) so its services can be
// imported into the foundational-services catalog agents already read.
//
// The vocabulary here is deliberately VENDOR-NEUTRAL and the importer that consumes it lives in
// `@cat-factory/agents`, one layer away from anything that knows a Backstage entity envelope.
// That split is the same one `ReleaseHealthProvider` draws around Datadog, and it earns its keep
// the same way: the adapter owns the whole of "what this vendor calls a service, an owner and an
// API definition", so a second portal is a second adapter rather than a branch inside the
// import.
//
// The adapter is constructed AROUND one workspace's opened connection, so nothing in this port
// carries a credential: a caller that can hold a client can already read that workspace's
// portal, and a port that took the bag per call would put plaintext on every signature the
// import passes it down.
// ---------------------------------------------------------------------------

/** One API interface a catalog service publishes. */
export interface ServiceCatalogApi {
  /** Slug within the service, derived from the portal's own name for the interface. */
  id: string
  title: string
  /**
   * The format the definition is stored (and rendered) as, or null when the portal declares a
   * type this platform serves no format for.
   *
   * Null rather than a guessed `openapi`, because the format decides how the document is fenced
   * for the agent and whether its operations are indexed, and mislabelling a protobuf file as
   * OpenAPI produces a contract that parses to zero operations while looking perfectly
   * registered. The importer reports a null as a SKIPPED api rather than storing it.
   */
  format: ApiContractFormat | null
  /** The interface definition verbatim (an OpenAPI/AsyncAPI document, SDL, or `.proto`). */
  definition: string
  /** The portal's own reference for this interface, kept as the stored contract's provenance. */
  ref: string
  /** The portal's change token for the interface (an etag / version), when it exposes one. */
  revision: string | null
}

/** One service, as the platform's neutral vocabulary describes it. */
export interface ServiceCatalogEntry {
  /** Lower-kebab slug: the id the imported foundational service is registered under. */
  id: string
  name: string
  /** One line: the catalog's relevance signal. */
  summary: string
  /**
   * The general description, COMPOSED by the adapter from everything the portal knows that a
   * reader needs: what the service does, who owns it, which system it belongs to, its
   * lifecycle, where its docs live.
   *
   * Composed prose rather than a field per portal attribute, deliberately. A portal carries a
   * dozen such attributes and each one added as a column here is a column that is null for
   * every other supply route (a direct upload, a linked repo) and a migration on both runtimes;
   * `description` is the field ADR 0031 already defines for "what it does, when to use it, what
   * it does not cover", and ownership is exactly that kind of fact.
   */
  description: string
  /** Free-form capability tags, from the portal's tags and its own type vocabulary. */
  capabilities: string[]
  /** The portal's own reference for the service, kept as the stored row's provenance. */
  ref: string
  /** The interfaces it publishes. Empty when it publishes none, or when APIs were not requested. */
  apis: ServiceCatalogApi[]
}

/**
 * What one read of the portal produced.
 *
 * Coverage and the two skip counts ride the RESULT rather than a log line, because the importer
 * has to turn them into what the operator is told and into the connection's own sync status: a
 * truncated read that reported only its service count would let a partial estate be presented
 * as the estate.
 */
export interface ServiceCatalogFetch {
  entries: ServiceCatalogEntry[]
  coverage: ServiceCatalogCoverage
  /** Entities the filter matched that yielded no usable service (no name, no identity). */
  skippedEntries: number
  /**
   * Interfaces a service DECLARES that this read could not produce a definition for: a type
   * with no format we serve, an entity the portal would not return, an empty or oversized
   * definition. Counted here so the import can say a service's interface list is a prefix.
   */
  skippedApis: number
}

/** How much of the portal one read may take. */
export interface ServiceCatalogFetchOptions {
  /** Portal-side filter terms, ANDed. */
  entityFilter: readonly string[]
  /** Whether to resolve each service's published interfaces. */
  includeApis: boolean
  /** Hard cap on services taken; a read that hits it reports `truncated`. */
  maxServices: number
}

/**
 * Reads one workspace's developer portal.
 *
 * `fetchCatalog` REJECTS on a transport or authorization failure rather than answering an empty
 * catalog: an unreachable portal and a portal with no matching services are opposite facts, and
 * an importer that could not tell them apart would tombstone a whole estate on a network blip.
 */
export interface ServiceCatalogClient {
  readonly provider: ServiceCatalogProvider
  fetchCatalog(options: ServiceCatalogFetchOptions): Promise<ServiceCatalogFetch>
  /** A cheap reachability + credential check. Answers a result; never throws for a bad answer. */
  probe(): Promise<ConnectionTestResult>
}

/**
 * Builds the client for a workspace's stored connection, or null when it has none.
 *
 * The seam the IMPORTER depends on, so the import never opens a credential bag itself and stays
 * testable with a fake that holds none. Rejects when a connection EXISTS but its bag will not
 * open, because that is a deployment fault with its own remedy and is not the same fact as a
 * workspace that never connected a portal.
 */
export type ResolveServiceCatalogClient = (
  workspaceId: string,
) => Promise<ServiceCatalogClient | null>
