import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Wire contracts for the SERVICE CATALOG connection: a workspace points the platform at the
// developer portal its organisation already runs (Backstage today) and the platform imports
// that portal's services (identity, ownership, and the API definitions each one publishes)
// into the FOUNDATIONAL SERVICES catalog agents already read
// (backend/docs/adr/0031-foundational-services.md).
//
// It is a THIRD supply route beside direct upload and a linked git repo, deliberately not a
// second agent-facing catalog: an agent that was told about a service twice, once per
// mechanism, is the accretion this reuse avoids. What the import produces is ordinary
// `workspace`-tier foundational services, so the tiered merge, the suppression sub-resource,
// the lazily-read contract documents and the injected `.cat-context/` files all work unchanged.
//
// Scoped to a WORKSPACE, like every other sealed vendor connection (observability, tracker,
// document sources). That is also what makes it work on a mothership-mode node: the credential
// bag travels as ciphertext and is opened by naming the row over the secret delegation, which
// is workspace-keyed by construction.
// ---------------------------------------------------------------------------

/**
 * Which developer-portal product a connection talks to.
 *
 * A picklist with one member rather than a bare literal, because the read surface, the SPA and
 * the stored row all name it: adding Port / Cortex / OpsLevel later is a member plus an adapter,
 * and every `Record<ServiceCatalogProvider, …>` fails to compile until it is mapped. The
 * platform-neutral vocabulary below (`ServiceCatalogEntry` in the kernel) is what the importer
 * consumes, so nothing downstream of the adapter knows the word "Backstage".
 */
export const serviceCatalogProviderSchema = v.picklist(['backstage'])
export type ServiceCatalogProvider = v.InferOutput<typeof serviceCatalogProviderSchema>

/**
 * How the platform authenticates to a SELF-HOSTED portal.
 *
 * These are the shapes organisations actually run Backstage behind, and each needs a different
 * request built, which is why this is a closed vocabulary rather than a free-form header bag:
 *
 * - `none`: no auth on the catalog API. Real, and common on an instance reachable only inside a
 *   VPN. It is admissible ONLY because the base URL is held to the deployment's
 *   `UrlSafetyPolicy`, so reaching a private host is an operator decision already made.
 * - `static-token`: a service-to-service token from Backstage's `backend.auth.externalAccess`
 *   (`type: static`), sent as `Authorization: Bearer <token>`. The vendor's own recommended
 *   way for an external system to read the catalog.
 * - `legacy-shared-secret`: the older external-access route, still what a great many
 *   self-hosted instances are configured for: a short-lived HS256 JWT signed with a secret
 *   from `backend.auth.keys[]`. The platform MINTS the token per request rather than storing
 *   one, which is why the stored credential is the secret and not a bearer value.
 * - `oauth2-client-credentials`: the portal sits behind an IdP or an identity-aware proxy
 *   (Keycloak, Okta, Entra, Google IAP). The platform exchanges a client id/secret at the
 *   token endpoint and sends the result as a bearer token.
 * - `basic`: HTTP Basic, i.e. a reverse proxy in front of the portal.
 * - `headers`: an explicit header list, for a gateway that authenticates on its own header
 *   names. A LIST rather than one pair because the common case needs two (a Cloudflare Access
 *   service token is `CF-Access-Client-Id` plus `CF-Access-Client-Secret`), and a single-pair
 *   shape would have sent half a credential.
 */
export const serviceCatalogAuthModeSchema = v.picklist([
  'none',
  'static-token',
  'legacy-shared-secret',
  'oauth2-client-credentials',
  'basic',
  'headers',
])
export type ServiceCatalogAuthMode = v.InferOutput<typeof serviceCatalogAuthModeSchema>

const secretValue = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(8_000))
const shortText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))
const url = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))

/**
 * A header name a gateway may authenticate on. Restricted to the RFC 7230 token characters this
 * platform will emit, so a stored credential can never inject a second header or a request line
 * (the value is checked the same way below, because a `\r\n` in either half is the same split).
 */
const headerName = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(100),
  v.regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'must be a valid HTTP header name'),
)

const headerValue = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(8_000),
  v.regex(/^[^\r\n]+$/, 'must not contain a line break'),
)

/** The credential half of a connection, discriminated by the auth mode it belongs to. */
export const serviceCatalogAuthSchema = v.variant('mode', [
  v.object({ mode: v.literal('none') }),
  v.object({ mode: v.literal('static-token'), token: secretValue }),
  v.object({ mode: v.literal('legacy-shared-secret'), sharedSecret: secretValue }),
  v.object({
    mode: v.literal('oauth2-client-credentials'),
    /** The IdP's token endpoint. Held to the same URL policy as the portal's own base URL. */
    tokenUrl: url,
    clientId: shortText,
    clientSecret: secretValue,
    /** Optional `scope` / `audience` request parameters some IdPs require. */
    scope: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
    audience: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  }),
  v.object({ mode: v.literal('basic'), username: shortText, password: secretValue }),
  v.object({
    mode: v.literal('headers'),
    headers: v.pipe(
      v.array(v.object({ name: headerName, value: headerValue })),
      v.minLength(1),
      v.maxLength(5),
    ),
  }),
])
export type ServiceCatalogAuth = v.InferOutput<typeof serviceCatalogAuthSchema>

/**
 * One term of the portal-side entity filter, `key=value`.
 *
 * The charset is deliberately tight: these terms are serialised into the vendor's query string,
 * so admitting `&` or `=` beyond the first would let a stored filter add query parameters the
 * platform never meant to send (a `limit`, a second `filter`, a `fields` projection that drops
 * the fields the importer reads). One `=`, no separators, no whitespace.
 */
const entityFilterTerm = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(3),
  v.maxLength(200),
  v.regex(
    /^[A-Za-z0-9_.-]+=[A-Za-z0-9_.:/@-]+$/,
    'must be a single `key=value` term (letters, digits and `_.-:/@`)',
  ),
)

/**
 * The default filter, applied when a connection names none: the portal's SERVICE-like
 * components.
 *
 * A default rather than a required field, because the honest alternative is worse in both
 * directions. Importing the WHOLE catalog would fold a thousand-entity estate into every
 * design prompt (the exact cost ADR 0031 split the catalog and contract reads to avoid), while
 * refusing to import without a filter makes the first connection fail on a vendor query language
 * the operator has no reason to know yet. `kind=component` is the one term that is right for
 * every Backstage instance, and a narrower estate (a tag, a system, an owner) is one term more.
 */
export const DEFAULT_SERVICE_CATALOG_FILTER: readonly string[] = ['kind=component']

/** How many services ONE import may bring in, and the ceiling on that number. */
export const DEFAULT_MAX_CATALOG_SERVICES = 200
export const MAX_CATALOG_SERVICES_CEILING = 1_000

/** Connect (or re-connect) the workspace's service catalog. Replaces any prior connection. */
export const connectServiceCatalogSchema = v.object({
  provider: v.optional(serviceCatalogProviderSchema),
  /** The portal's base URL, e.g. `https://backstage.corp.internal`. */
  baseUrl: url,
  auth: serviceCatalogAuthSchema,
  /**
   * Portal-side filter terms, ANDed. Empty/absent ⇒ {@link DEFAULT_SERVICE_CATALOG_FILTER}.
   * Filtering AT THE PORTAL rather than after the fetch is what keeps a large estate from being
   * paged through in full on every refresh.
   */
  entityFilter: v.optional(v.pipe(v.array(entityFilterTerm), v.maxLength(10))),
  /**
   * Whether to import the API definitions each service publishes (`spec.providesApis`).
   * Defaults to true, being the half of the ask that lets a consumer call a shared service
   * rather than merely know it exists.
   */
  includeApis: v.optional(v.boolean()),
  /** Cap on imported services. Defaults to {@link DEFAULT_MAX_CATALOG_SERVICES}. */
  maxServices: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CATALOG_SERVICES_CEILING)),
  ),
})
export type ConnectServiceCatalogInput = v.InferOutput<typeof connectServiceCatalogSchema>

/**
 * How much of the portal's matching estate one import covered.
 *
 * Three states rather than a count, for the reason the repo-source `folderScan` coverage has
 * three: each needs a different fix from the person who connected it, and `truncated` must never
 * read as `complete`. An importer that reported only "42 services" would leave an operator with
 * a 300-service estate believing the catalog is the estate.
 */
export const serviceCatalogCoverageSchema = v.picklist([
  /** Every matching entity was imported. */
  'complete',
  /** The `maxServices` cap stopped the paging short, so the catalog is a PREFIX of the estate. */
  'truncated',
  /**
   * The filter matched nothing at all. Kept apart from `complete` because zero services is
   * never a healthy `complete`: it is a filter that names a kind, tag or system the portal does
   * not use, and the remedy is editing the filter rather than waiting for a sync.
   */
  'empty',
])
export type ServiceCatalogCoverage = v.InferOutput<typeof serviceCatalogCoverageSchema>

/** What the LAST import concluded, as the management surface reports it. */
export const serviceCatalogSyncStatusSchema = v.picklist([
  /** Everything the filter matched arrived, with nothing dropped. */
  'ok',
  /**
   * The import ran and is INCOMPLETE: truncated by the cap, or with entities/definitions it
   * could not use. Distinct from `failed`: the catalog holds real services, it just does not
   * hold all of them, and only naming that keeps a partial estate from reading as the estate.
   */
  'partial',
  /** The import could not read the portal at all; whatever the catalog holds is from before. */
  'failed',
])
export type ServiceCatalogSyncStatus = v.InferOutput<typeof serviceCatalogSyncStatusSchema>

/**
 * The connection as the management surface sees it: never a credential, not even a masked one.
 *
 * `authMode` is here because it is the one part of the credential that is configuration rather
 * than secret, because the operator has to see WHICH scheme a stored connection uses to know whether
 * it still matches how the portal is deployed.
 */
export const serviceCatalogConnectionSchema = v.object({
  provider: serviceCatalogProviderSchema,
  baseUrl: v.string(),
  authMode: serviceCatalogAuthModeSchema,
  entityFilter: v.array(v.string()),
  includeApis: v.boolean(),
  maxServices: v.number(),
  lastSyncedAt: v.nullable(v.number()),
  lastSyncStatus: v.nullable(serviceCatalogSyncStatusSchema),
  /**
   * What the last import wants a human to know: the truncation, the unreadable definitions, or
   * the transport failure. Null when the last pass had nothing to report, which is the only
   * state that needs no sentence.
   */
  lastSyncMessage: v.nullable(v.string()),
  connectedAt: v.number(),
})
export type ServiceCatalogConnection = v.InferOutput<typeof serviceCatalogConnectionSchema>

/** Outcome of one import: what changed in the catalog, and what the pass could not do. */
export const serviceCatalogSyncResultSchema = v.object({
  upserted: v.number(),
  /** Services this connection produced before and the portal no longer offers. */
  tombstoned: v.number(),
  unchanged: v.number(),
  /** API definitions stored across every imported service. */
  contracts: v.number(),
  coverage: serviceCatalogCoverageSchema,
  /**
   * Entities the filter matched that did NOT become a service: no usable identity, or a name
   * that yields no slug. Zero and "nothing matched" are told apart by {@link coverage}, and a
   * non-zero value here is the only thing that explains a catalog thinner than the portal's
   * own entity count.
   */
  skippedServices: v.number(),
  /**
   * API definitions a service DECLARES that this pass could not store: a type the platform
   * serves no format for, an entity the portal would not return, an empty or oversized
   * definition. Reported rather than dropped, because a service listed with no interface reads
   * to an agent as a service that publishes none.
   */
  skippedApis: v.number(),
  status: serviceCatalogSyncStatusSchema,
})
export type ServiceCatalogSyncResult = v.InferOutput<typeof serviceCatalogSyncResultSchema>
