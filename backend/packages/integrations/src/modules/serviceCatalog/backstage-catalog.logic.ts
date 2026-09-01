import type { ApiContractFormat } from '@cat-factory/contracts'
import { RESERVED_CAPABILITY_TAGS, reservedCapabilityNearMiss } from '@cat-factory/contracts'
import type { ServiceCatalogApi, ServiceCatalogEntry } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Backstage-specific PURE logic: turning a Software Catalog entity into the platform's neutral
// `ServiceCatalogEntry`, and back the other way for the query it takes to fetch one.
//
// Everything that knows what Backstage calls a service, an owner or an API definition lives in
// this file and its client sibling. The importer that consumes the result
// (`ServiceCatalogSyncService` in `@cat-factory/agents`) sees only the neutral vocabulary, which
// is what makes a second portal product a second adapter rather than a branch inside the import.
//
// No I/O, so every mapping rule below is unit-testable without a live instance.
// ---------------------------------------------------------------------------

/** The namespace Backstage uses when an entity declares none. */
const DEFAULT_NAMESPACE = 'default'

/** How long a composed description may run: the catalog's own limit for the field. */
export const MAX_DESCRIPTION_CHARS = 20_000

/** How long a summary line may run: the catalog's own limit for the field. */
const MAX_SUMMARY_CHARS = 400

/** How many capability tags one imported service may carry. */
const MAX_CAPABILITIES = 20

/**
 * How large one API definition may be and still be stored.
 *
 * The same ceiling a direct upload is held to, deliberately: a document past it is not served to
 * an agent in any useful form (the contract render caps far lower and says what it dropped), and
 * letting the import store what an upload would be refused would make the two supply routes
 * disagree about what a contract is.
 */
export const MAX_DEFINITION_CHARS = 1_000_000

/** A Backstage entity, as much of it as this adapter reads. */
export interface BackstageEntity {
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
    title?: string
    description?: string
    tags?: string[]
    etag?: string
    annotations?: Record<string, string>
    links?: { url?: string; title?: string }[]
  }
  spec?: {
    type?: string
    lifecycle?: string
    owner?: string
    system?: string
    domain?: string
    definition?: string
    providesApis?: string[]
  }
}

/** A parsed entity reference (`component:default/orders`). */
export interface BackstageEntityRef {
  kind: string
  namespace: string
  name: string
}

/**
 * Parse one of the several shapes Backstage accepts for a reference, with `defaultKind` filling
 * the one a compact reference omits.
 *
 * Compact references are the norm rather than an edge case: `spec.owner: payments` and
 * `providesApis: [orders-api]` are what a hand-written `catalog-info.yaml` contains, and the
 * kind is implied by the FIELD they appear in. Returns null when there is no name at all, so a
 * malformed reference is reported rather than resolved to something plausible.
 */
export function parseEntityRef(raw: string, defaultKind: string): BackstageEntityRef | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const colon = trimmed.indexOf(':')
  const kind = colon === -1 ? defaultKind : trimmed.slice(0, colon)
  const rest = colon === -1 ? trimmed : trimmed.slice(colon + 1)
  const slash = rest.indexOf('/')
  const namespace = slash === -1 ? DEFAULT_NAMESPACE : rest.slice(0, slash)
  const name = slash === -1 ? rest : rest.slice(slash + 1)
  if (!kind.trim() || !name.trim()) return null
  return {
    kind: kind.trim().toLowerCase(),
    namespace: (namespace.trim() || DEFAULT_NAMESPACE).toLowerCase(),
    name: name.trim(),
  }
}

/** Render a reference in the canonical `kind:namespace/name` form the API addresses entities by. */
export function formatEntityRef(ref: BackstageEntityRef): string {
  return `${ref.kind}:${ref.namespace}/${ref.name}`
}

/** The canonical reference for an entity as it came back, or null when it carries no name. */
export function entityRef(entity: BackstageEntity): string | null {
  const name = entity.metadata?.name?.trim()
  if (!name) return null
  return formatEntityRef({
    kind: (entity.kind ?? 'component').toLowerCase(),
    namespace: entity.metadata?.namespace?.trim() || DEFAULT_NAMESPACE,
    name,
  })
}

/**
 * The foundational-service id an entity is imported under: its name as a lower-kebab slug,
 * prefixed with its namespace when that is not the default one.
 *
 * The namespace prefix is what keeps the id unique. Backstage namespaces exist precisely so two
 * teams can both own an `api` component, and slugging on the name alone would collapse them onto
 * one catalog entry, silently, and in favour of whichever the portal paged first. The `default`
 * namespace is left off because it is the one every hand-written entity lands in, and prefixing
 * it would put `default-` in front of an organisation's entire estate.
 *
 * Null when nothing slug-shaped survives (a name of only punctuation), which the caller reports
 * as a skipped entity rather than importing under a generated id nobody can look up.
 */
export function serviceIdForEntity(entity: BackstageEntity): string | null {
  const name = slugify(entity.metadata?.name ?? '')
  if (!name) return null
  const namespace = entity.metadata?.namespace?.trim().toLowerCase()
  const prefix = namespace && namespace !== DEFAULT_NAMESPACE ? `${slugify(namespace)}-` : ''
  return slugify(`${prefix}${name}`) || null
}

/**
 * A lower-kebab slug, or the empty string when the input holds nothing slug-shaped.
 *
 * Capped at the 64 characters the catalog's own id rule allows, and the cap is a plain prefix by
 * design: a truncated slug still has to be STABLE across imports, and any cleverer strategy (a
 * hash suffix, dropping interior words) would produce a different id the day a name grows.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

/**
 * The format an API entity's declared `spec.type` maps to, or null when the platform serves none
 * for it.
 *
 * Null rather than a fallback, and that is the whole point of the function. Backstage's API type
 * is an open vocabulary (`trpc`, `sql`, `soap` and anything an organisation invents all appear),
 * and storing one of those AS OpenAPI would produce a contract that fails the OpenAPI parse and
 * lists zero operations, which reads to an Architect as a fully-specified service that offers no
 * endpoints. The importer reports a null as a skipped interface instead, which says the opposite
 * and is true.
 */
export function apiContractFormatForType(type: string | undefined): ApiContractFormat | null {
  switch (type?.trim().toLowerCase()) {
    case 'openapi':
      return 'openapi'
    case 'asyncapi':
      return 'asyncapi'
    case 'graphql':
      return 'graphql'
    case 'grpc':
      return 'grpc'
    default:
      return null
  }
}

/** The annotation carrying a component's TechDocs location, when it publishes docs. */
const TECHDOCS_ANNOTATION = 'backstage.io/techdocs-ref'

/** The annotation carrying a component's source location (its repository). */
const SOURCE_LOCATION_ANNOTATION = 'backstage.io/source-location'

/**
 * Map one catalog entity onto the platform's neutral entry, with `apis` supplied separately
 * (they are separate entities, fetched in one batch rather than one request per service).
 *
 * Returns null when the entity yields no usable identity, which the caller counts as skipped.
 */
export function toServiceCatalogEntry(
  entity: BackstageEntity,
  apis: ServiceCatalogApi[],
): ServiceCatalogEntry | null {
  const id = serviceIdForEntity(entity)
  const ref = entityRef(entity)
  if (!id || !ref) return null
  const metadata = entity.metadata ?? {}
  return {
    id,
    name: (metadata.title?.trim() || metadata.name?.trim() || id).slice(0, 200),
    summary: entitySummary(entity),
    description: composeDescription(entity),
    capabilities: entityCapabilities(entity),
    ref,
    apis,
  }
}

/**
 * The one-line relevance signal.
 *
 * Falls back to the facts the entity DOES carry rather than to a placeholder, because a catalog
 * whose every summary reads "no description" is a catalog a reader stops reading. A component's
 * type and owner are the two things a portal always has, and together they are a real answer to
 * "is this the service I am looking for".
 */
export function entitySummary(entity: BackstageEntity): string {
  const described = firstLine(entity.metadata?.description ?? '')
  if (described) return described.slice(0, MAX_SUMMARY_CHARS)
  const type = entity.spec?.type?.trim() || (entity.kind ?? 'component').toLowerCase()
  const owner = ownerLabel(entity.spec?.owner)
  const summary = owner ? `${type} owned by ${owner}` : `${type} with no recorded owner`
  return summary.slice(0, MAX_SUMMARY_CHARS)
}

/**
 * The composed description: the portal's structured facts as labelled lines, then the entity's
 * own prose.
 *
 * The ORDER is the load-bearing part. Ownership is what a triage reader needs first and it is
 * also what a cap must never drop, so the labelled facts come before the free text and the
 * truncation falls on the prose. A description that lost its owner line to a long README excerpt
 * would be the one field this composition exists to guarantee.
 */
export function composeDescription(entity: BackstageEntity): string {
  const spec = entity.spec ?? {}
  const metadata = entity.metadata ?? {}
  const facts: string[] = []
  const owner = ownerLabel(spec.owner)
  facts.push(owner ? `Owner: ${owner}` : 'Owner: not recorded in the catalog')
  if (spec.system?.trim()) facts.push(`System: ${spec.system.trim()}`)
  if (spec.domain?.trim()) facts.push(`Domain: ${spec.domain.trim()}`)
  if (spec.lifecycle?.trim()) facts.push(`Lifecycle: ${spec.lifecycle.trim()}`)
  if (spec.type?.trim()) facts.push(`Type: ${spec.type.trim()}`)
  const source = metadata.annotations?.[SOURCE_LOCATION_ANNOTATION]?.trim()
  if (source) facts.push(`Source: ${source}`)
  const docs = metadata.annotations?.[TECHDOCS_ANNOTATION]?.trim()
  if (docs) facts.push(`Docs: ${docs}`)
  const links = (metadata.links ?? [])
    .map((link) => describeLink(link))
    .filter((line): line is string => line !== null)
  if (links.length > 0) facts.push(`Links: ${links.join(', ')}`)
  const prose = (metadata.description ?? '').trim()
  const composed = prose ? `${facts.join('\n')}\n\n${prose}` : facts.join('\n')
  return composed.slice(0, MAX_DESCRIPTION_CHARS)
}

function describeLink(link: { url?: string; title?: string }): string | null {
  const url = link.url?.trim()
  if (!url) return null
  const title = link.title?.trim()
  return title ? `${title} (${url})` : url
}

/**
 * A readable owner: the reference's NAME, with the full reference beside it.
 *
 * Both halves, because they answer different questions. `payments` is what a human recognises
 * and what an agent can put in a report; `group:default/payments` is what someone can look up in
 * the portal. Rendering only the reference makes the estate read like machine output, and
 * rendering only the name loses which namespace (and which kind of owner) it belongs to.
 */
export function ownerLabel(owner: string | undefined): string | null {
  if (!owner?.trim()) return null
  const ref = parseEntityRef(owner, 'group')
  if (!ref) return null
  return `${ref.name} (${formatEntityRef(ref)})`
}

/**
 * The capability tags an imported service carries: the entity's own tags plus its declared type.
 *
 * A RESERVED platform tag is dropped rather than imported, and that is a rule rather than a cap.
 * `asset-storage` and `generation-context` are spellings the platform assigns meaning to (the
 * first makes a service selectable as a binary-output step's storage target), so accepting one
 * from an external portal would let whoever edits a `catalog-info.yaml` enrol a component into a
 * platform capability that nobody at this deployment chose. A NEAR-MISS of a reserved tag goes
 * the same way, since importing it would put a tag in the catalog that reads as the reserved one
 * and behaves as nothing.
 */
export function entityCapabilities(entity: BackstageEntity): string[] {
  const raw = [...(entity.metadata?.tags ?? []), entity.spec?.type ?? '']
  const out: string[] = []
  for (const value of raw) {
    const tag = slugify(value)
    if (!tag) continue
    if (RESERVED_CAPABILITY_TAGS.includes(tag) || reservedCapabilityNearMiss(tag)) continue
    if (out.includes(tag)) continue
    out.push(tag)
    if (out.length >= MAX_CAPABILITIES) break
  }
  return out
}

/** The API entity references one component declares, canonicalised and de-duplicated. */
export function providedApiRefs(entity: BackstageEntity): string[] {
  const out: string[] = []
  for (const raw of entity.spec?.providesApis ?? []) {
    const ref = parseEntityRef(raw, 'api')
    if (!ref) continue
    const formatted = formatEntityRef(ref)
    if (!out.includes(formatted)) out.push(formatted)
  }
  return out
}

/**
 * Map one API entity onto a neutral interface, or null when it carries nothing storable.
 *
 * The three null cases are deliberately not distinguished HERE (an unusable type, an empty
 * definition and an oversized one all become one skipped interface), because the caller reports
 * a count and every one of them has the same remedy at the portal: give the API entity a
 * definition this platform can serve. What must not happen is any of them being stored anyway.
 */
export function toServiceCatalogApi(entity: BackstageEntity): ServiceCatalogApi | null {
  const ref = entityRef(entity)
  const id = slugify(entity.metadata?.name ?? '')
  if (!ref || !id) return null
  const definition = entity.spec?.definition
  if (typeof definition !== 'string') return null
  const trimmed = definition.trim()
  if (!trimmed || trimmed.length > MAX_DEFINITION_CHARS) return null
  const format = apiContractFormatForType(entity.spec?.type)
  if (!format) return null
  return {
    id,
    title: (entity.metadata?.title?.trim() || entity.metadata?.name?.trim() || id).slice(0, 200),
    format,
    definition,
    ref,
    revision: entity.metadata?.etag?.trim() || null,
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0]?.trim() ?? ''
}

/**
 * The `fields` projection the LIST request asks for.
 *
 * Naming the fields is what keeps a large estate's listing cheap: without it Backstage returns
 * every entity in full, relations included, and an API entity's `spec.definition` can be
 * hundreds of kilobytes. `spec.definition` is deliberately absent here: the definitions are
 * read in the second, batched request, for only the APIs the imported components actually
 * declare.
 */
export const CATALOG_LIST_FIELDS: readonly string[] = [
  'kind',
  'metadata.name',
  'metadata.namespace',
  'metadata.title',
  'metadata.description',
  'metadata.tags',
  'metadata.annotations',
  'metadata.links',
  'metadata.etag',
  'spec.type',
  'spec.lifecycle',
  'spec.owner',
  'spec.system',
  'spec.domain',
  'spec.providesApis',
]

/** The `fields` projection the batched API-entity request asks for: the list plus definitions. */
export const API_FETCH_FIELDS: readonly string[] = [...CATALOG_LIST_FIELDS, 'spec.definition']
