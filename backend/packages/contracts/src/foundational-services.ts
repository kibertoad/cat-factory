import * as v from 'valibot'
import {
  capabilityCredentialSchema,
  uniqueCredentialInjectionNames,
} from './capability-credentials.js'
import { fragmentOwnerKindSchema } from './fragment-library.js'

// ---------------------------------------------------------------------------
// Wire contracts for the FOUNDATIONAL SERVICES catalog
// (backend/docs/adr/0031-foundational-services.md).
//
// A foundational service is a shared capability the organisation already runs —
// file storage, notifications, audit, feature flags — that a designed system is
// expected to CONSUME rather than reinvent. Each carries a human description plus
// one or more API contracts (an OpenAPI 3.x document, a `@toad-contracts/core`
// contract module, or a `@lokalise/api-contract` module), supplied either by direct
// upload or by pointing at files/folders in a git repo (cached + autorefreshed).
//
// Registration is TIERED exactly like the prompt-fragment library: a `builtin` definition
// registered in code by the deployment is shared by every account, an `account` row wins
// over it, and a `workspace` row wins over both. The resolved catalog is what the Architect
// sees; the contract BODIES are read lazily, only for the services the Architect declared,
// and only by the downstream kinds that need them.
// ---------------------------------------------------------------------------

/** Which scope owns a foundational service / source: an account, or a workspace. */
export const foundationalServiceOwnerKindSchema = fragmentOwnerKindSchema
export type FoundationalServiceOwnerKind = v.InferOutput<typeof foundationalServiceOwnerKindSchema>

/**
 * The tier a resolved catalog entry originated from, lowest-precedence first.
 *
 * `builtin` is the DEPLOYMENT's own tier: services a deployment registers in code on the
 * app-owned `FoundationalServiceRegistry`, exactly as it registers pipelines or task types.
 * It carries no rows, so it is present from a workspace's first request and cannot drift from
 * the definitions; an account or workspace row of the same id still wins over it, and a
 * tombstone at either tier suppresses it.
 */
export const foundationalServiceTierSchema = v.picklist(['builtin', 'account', 'workspace'])
export type FoundationalServiceTier = v.InferOutput<typeof foundationalServiceTierSchema>

/**
 * The API-contract document formats the catalog accepts. Each is stored verbatim as text and
 * additionally INDEXED into operation names where the format allows it — see
 * {@link operationsAreIndexable}, which is the one place that judgement lives.
 */
export const apiContractFormatSchema = v.picklist([
  /** An OpenAPI 3.x document, JSON or YAML. */
  'openapi',
  /** A module built on `@toad-contracts/core` (`defineApiContract(...)`). */
  'toad-contract',
  /** A module built on `@lokalise/api-contract` (`buildPayloadRoute` / `buildGetRoute` …). */
  'lokalise-api-contract',
  /**
   * An AsyncAPI 2.x/3.x document, JSON or YAML: an event-driven interface (topics, channels,
   * message payloads). Added with the service-catalog import, because an org's catalog
   * routinely describes a queue consumer alongside its HTTP services and folding an AsyncAPI
   * document in as `openapi` would have it fail the OpenAPI parse and register as a service
   * whose interface declares nothing.
   */
  'asyncapi',
  /** A GraphQL schema (SDL). */
  'graphql',
  /** A Protocol Buffers service definition (`.proto`). */
  'grpc',
])
export type ApiContractFormat = v.InferOutput<typeof apiContractFormatSchema>

/**
 * Whether an operation index can be derived from a document of this format at all.
 *
 * This is what keeps "this interface declares no operations" apart from "this platform does not
 * read this format": both render as an empty `operations` list, they need opposite reactions
 * from whoever reads the catalog, and collapsing them tells an Architect that a fully-specified
 * service offers nothing. Every surface that renders an operation list branches on it — the
 * agent-facing catalog and the SPA's manifest row alike — so the two cannot disagree.
 *
 * `lokalise-api-contract` is false because its route builders' shapes are not pinned down here
 * and a partial guess at them would be reported as fact. Adding an extractor for it means
 * flipping this and nothing else.
 *
 * `asyncapi` is TRUE for the same reason `openapi` is: the document is JSON/YAML and its
 * channels (2.x) or operations (3.x) are a declared map, so the index is a parse rather than a
 * guess. `graphql` and `grpc` are false: SDL and protobuf are neither, and a brace-counting
 * regex over them would name root fields that a nested type or an `extend type Query` block
 * makes up. An invented operation is worse than a missing one, because a consumer writes
 * against it.
 */
export function operationsAreIndexable(format: ApiContractFormat): boolean {
  return format === 'openapi' || format === 'toad-contract' || format === 'asyncapi'
}

/**
 * The capability tag a foundational service must carry to be selectable as a binary-output
 * step's STORAGE target (enforced at run admission — see `docs/initiatives/
 * binary-output-foundational-storage.md`).
 *
 * It lives here, on the wire, rather than in the kernel alone because the people who need to
 * spell it right are OUTSIDE the backend: a deployment registering its estate, and the SPA
 * rendering the picker. A client that cannot import the vocabulary re-declares it, and the
 * failure of a re-declaration is silent — `asset_storage` registers cleanly and surfaces much
 * later as a refused run.
 */
export const ASSET_STORAGE_CAPABILITY = 'asset-storage'

/**
 * The CONVENTIONAL tag for a service that can scope a generation — an inventory answering
 * "what entities exist, which lack an asset, how is each described". Deliberately NOT enforced
 * (any service with a readable contract can inform scope), but still reserved: a picker orders
 * by it, so a typo silently loses the ordering rather than failing.
 */
export const GENERATION_CONTEXT_CAPABILITY = 'generation-context'

/**
 * Capability tags the PLATFORM assigns meaning to. Everything else is free-form org taxonomy
 * and stays that way — this list is not a closed vocabulary, it is the set of spellings a
 * registrant must not miss by a character.
 */
export const RESERVED_CAPABILITY_TAGS: readonly string[] = [
  ASSET_STORAGE_CAPABILITY,
  GENERATION_CONTEXT_CAPABILITY,
]

/**
 * The reserved tag `tag` was plainly TRYING to be, when it is not that tag exactly — else null.
 *
 * Capability tags are free-form strings, which is right (an org's taxonomy is its own) and is
 * also why `asset_storage` / `Asset-Storage` / `assetstorage` register without complaint and
 * fail a run hours later as `not_storage_capable`. Comparing on a form with separators and case
 * removed catches exactly the near-misses and nothing else: a genuinely different tag does not
 * collide with a reserved one under it.
 *
 * The caller REFUSES on a hit rather than silently canonicalising, because a registrant who
 * meant a tag of their own under a colliding spelling must learn that the platform reads it as
 * reserved, and a quiet rewrite of someone's taxonomy is its own surprise.
 */
export function reservedCapabilityNearMiss(tag: string): string | null {
  if (RESERVED_CAPABILITY_TAGS.includes(tag)) return null
  const normalized = normalizeCapabilityTag(tag)
  return (
    RESERVED_CAPABILITY_TAGS.find((reserved) => normalizeCapabilityTag(reserved) === normalized) ??
    null
  )
}

function normalizeCapabilityTag(tag: string): string {
  return tag.toLowerCase().replace(/[\s_-]+/g, '')
}

/**
 * A contract as the CATALOG lists it — identity, format and SIZE, never the body. This is
 * what the Architect's catalog carries: enough to decide whether a service is relevant and
 * what shape its interface takes, without paying for a 200 KB OpenAPI document per service
 * on every design dispatch.
 */
export const apiContractSummarySchema = v.object({
  contractId: v.string(),
  format: apiContractFormatSchema,
  title: v.string(),
  /** Byte length of the stored document — the cost signal for a lazy read. */
  size: v.number(),
  /** Repo provenance (`path`), or null when uploaded directly. */
  path: v.nullable(v.string()),
  /**
   * The operations this document declares (`GET /files/{id}` …), capped. Cheap enough to ride
   * the catalog and it is what makes the catalog actionable — an architect can name the
   * endpoint it intends to call.
   *
   * EMPTY means one of two different things and {@link operationsAreIndexable} is what tells
   * them apart: this format is not read at all, or it is and this document declares nothing.
   */
  operations: v.array(v.string()),
  /**
   * How many operations the document declares that {@link operations} does NOT list — dropped
   * by the cap, or (for a contract MODULE) declared in a shape the static extractor could not
   * read. Non-zero says the list is incomplete, so a reader never concludes the rest does not
   * exist.
   */
  omittedOperations: v.number(),
})
export type ApiContractSummary = v.InferOutput<typeof apiContractSummarySchema>

/** A contract WITH its document body — the lazy read a downstream agent's context folds in. */
export const apiContractDocumentSchema = v.object({
  ...apiContractSummarySchema.entries,
  /** The document verbatim (OpenAPI JSON/YAML, or the contract module's TypeScript source). */
  body: v.string(),
})
export type ApiContractDocument = v.InferOutput<typeof apiContractDocumentSchema>

/** A registered foundational service, as the management surface sees it. */
export const foundationalServiceSchema = v.object({
  /** Stable slug the Architect names in its design (e.g. `file-storage`). */
  id: v.string(),
  ownerKind: foundationalServiceOwnerKindSchema,
  name: v.string(),
  /** One line; the catalog's relevance signal. */
  summary: v.string(),
  /** The general description — what it does, when to use it, what it does NOT cover. */
  description: v.string(),
  /** Free-form capability tags (`file-storage`, `notifications`, `audit`). */
  capabilities: v.array(v.string()),
  /** Contract manifest — never bodies (see {@link apiContractSummarySchema}). */
  contracts: v.array(apiContractSummarySchema),
  /** Provenance when repo-sourced: the source that produced this row. */
  sourceId: v.nullable(v.string()),
  sourcePath: v.nullable(v.string()),
  /** Head commit the service's directory was pinned to at the last sync. */
  pinnedCommit: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type FoundationalService = v.InferOutput<typeof foundationalServiceSchema>

/**
 * A resolved (builtin ⊕ account ⊕ workspace merged) catalog entry, carrying its winning tier.
 *
 * Deliberately NARROWER than {@link foundationalServiceSchema}: the merged read carries only
 * what every tier can honestly fill. A `builtin` entry is registered in code, so it has no
 * owning scope, no repo provenance and no row timestamps — and the alternative to dropping
 * those fields is filling them with placeholders that read as facts. They remain on the
 * per-tier management read, which is where a stored row's provenance belongs.
 */
export const resolvedFoundationalServiceSchema = v.object({
  id: v.string(),
  name: v.string(),
  summary: v.string(),
  description: v.string(),
  capabilities: v.array(v.string()),
  contracts: v.array(apiContractSummarySchema),
  /**
   * The credentials this service authenticates with, by KEY NAME only. Present only on a
   * `builtin` entry, because only the code-registered tier may declare one (see
   * {@link createFoundationalServiceSchema}); an account or workspace row carries none and this
   * is absent rather than empty for it.
   */
  credentials: v.optional(v.array(capabilityCredentialSchema)),
  tier: foundationalServiceTierSchema,
})
export type ResolvedFoundationalService = v.InferOutput<typeof resolvedFoundationalServiceSchema>

/**
 * One SUPPRESSION a tier is asserting: an id it tombstones, so the service it inherits under
 * that id — a `builtin` the deployment registered, or (for a board) an account service — loses
 * the merge.
 *
 * A suppressed id is by construction absent from the merged catalog, which is what makes this a
 * separate read rather than a flag on it — without it the management surface could offer no way
 * back, and suppression would be a one-way door.
 *
 * `inherited` is the honest half: `false` says the tombstone currently shadows NOTHING (the
 * tier below withdrew the service, or this tier deleted its own registration), so a reader does
 * not conclude a capability is being withheld when there is none to withhold. The name is the
 * inherited service's when there is one and the tombstone's own otherwise, which is empty for a
 * suppression written against an id this tier never registered.
 */
export const foundationalServiceSuppressionSchema = v.object({
  id: v.string(),
  name: v.string(),
  summary: v.string(),
  inherited: v.boolean(),
})
export type FoundationalServiceSuppression = v.InferOutput<
  typeof foundationalServiceSuppressionSchema
>

const slug = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lower-kebab slug'),
)

/** One contract supplied by DIRECT UPLOAD (body inline on the request). */
export const uploadApiContractSchema = v.object({
  contractId: slug,
  format: apiContractFormatSchema,
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  /** The document text. Capped so one upload cannot make a catalog read unbounded. */
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000_000)),
})
export type UploadApiContract = v.InferOutput<typeof uploadApiContractSchema>

/** Register a foundational service at the addressed tier. */
export const createFoundationalServiceSchema = v.pipe(
  v.object({
    id: slug,
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
    summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400)),
    description: v.pipe(v.string(), v.trim(), v.maxLength(20_000)),
    capabilities: v.optional(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64))),
    ),
    contracts: v.optional(v.array(uploadApiContractSchema)),
    /**
     * The credentials a step must authenticate to this service WITH, declared by key name and
     * never by value, resolved per dispatch through the same `ToolSecretResolver` a generative
     * integration's are and injected into the job as named environment variables. The service's
     * own `description` and contract document are what tell the agent which variable carries
     * what, exactly as an integration's `usage` does.
     *
     * Only the DEPLOYMENT's own code-registered (`builtin`) tier may declare these, and the
     * write boundary refuses them on a stored account/workspace row
     * ({@link storedTierMayNotDeclareCredentials}). The reason is the resolver's shipped default:
     * it reads the declared key off the DEPLOYMENT'S OWN ENVIRONMENT, so a declaration is a
     * request to read deployment-level secret state and hand it to an agent process. Every other
     * declarer on the platform (tool servers, generative integrations) is deployment code, where
     * that is the same trust boundary as the process itself; a foundational service is the first
     * one a workspace ADMIN can also create over REST, and there the two are not the same at all.
     * `isReservedPlatformEnvKey` bounds the damage to non-platform variables, which is a floor,
     * not a licence.
     *
     * A per-workspace credential is still perfectly reachable: the deployment declares the KEY in
     * code and each workspace stores its own VALUE in the sealed capability-credential store,
     * which is the split that store exists for.
     */
    credentials: v.optional(v.array(capabilityCredentialSchema)),
  }),
  v.check(
    (service) => uniqueCredentialInjectionNames(service.credentials ?? []),
    'each credential must arrive as its own environment variable (duplicate injection name)',
  ),
)
export type CreateFoundationalServiceInput = v.InferOutput<typeof createFoundationalServiceSchema>

/**
 * The refusal a STORED (account / workspace) foundational service earns by declaring credentials,
 * or null when it declares none.
 *
 * A message rather than a boolean because the caller throws it verbatim, and the operator's next
 * move is not obvious from "not allowed": the capability they want does exist, one layer over, and
 * this names it.
 *
 * The rule cannot live in the schema, because ONE schema serves both doors on purpose: the REST
 * write boundary and `foundationalServiceDefinitionIssues`, which holds a deployment's
 * code-registered definition to exactly what an uploaded one must satisfy. What differs between
 * them is not the SHAPE but the DECLARER, and only the caller knows which one it is.
 */
export function storedTierMayNotDeclareCredentials(input: {
  credentials?: unknown[]
}): string | null {
  if (!input.credentials?.length) return null
  return (
    'A foundational service registered here cannot declare credentials: the resolver reads a ' +
    "declared key off the deployment's own environment, so only a service the deployment " +
    'registers in code may name one. To give this service a credential, declare the KEY on the ' +
    "code-registered definition and store each workspace's VALUE under that key in the " +
    'capability-credential settings.'
  )
}

/**
 * The ways `definition` fails {@link createFoundationalServiceSchema}, as readable lines — empty
 * when it would be accepted.
 *
 * Exists so a caller that cannot depend on valibot (the backend's kernel and orchestration
 * layers) can still hold a deployment's CODE-registered service to the very schema the REST
 * write boundary applies. Re-stating those rules in a second place is how a code-registered
 * definition ends up accepted where an uploaded one is refused.
 */
export function foundationalServiceDefinitionIssues(definition: unknown): string[] {
  const parsed = v.safeParse(createFoundationalServiceSchema, definition)
  if (parsed.success) return []
  return parsed.issues.map((issue) => {
    const path = issue.path?.map((segment) => String(segment.key)).join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
}

/**
 * Patch a registered service. `contracts`, when present, REPLACES the whole uploaded set —
 * a contract document has no meaningful partial edit, and a merge would leave a removed
 * endpoint file in the catalog with nothing saying it was withdrawn.
 */
export const updateFoundationalServiceSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  summary: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400))),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(20_000))),
  capabilities: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)))),
  contracts: v.optional(v.array(uploadApiContractSchema)),
  /**
   * Refused rather than accepted, for the reason {@link createFoundationalServiceSchema} gives:
   * a stored row may not declare credentials, and this is the door that would otherwise add them
   * to one that was created without any. Present in the schema at all so the refusal is a stated
   * rule with a message, rather than a field silently stripped by object parsing.
   */
  credentials: v.optional(v.array(capabilityCredentialSchema)),
})
export type UpdateFoundationalServiceInput = v.InferOutput<typeof updateFoundationalServiceSchema>

/**
 * How a linked repo source maps to services — the "folders or files" half of the ask.
 *
 * - `directory`: every immediate SUBDIRECTORY of `dirPath` is one service, described by a
 *   `service.md` (YAML frontmatter + markdown body) with its contract documents beside it.
 * - `folder`: the WHOLE of `dirPath` — optionally including its subfolders — is the contract
 *   set of the ONE service the source names. Every file under it whose extension could be a
 *   contract document is read and kept if it is one.
 * - `files`: an explicit list of contract file PATHS, all attached to the ONE service the
 *   source names. This is the "just point at my openapi.yaml" case, where there is no
 *   directory convention to adopt.
 *
 * `folder` and `files` differ in WHEN the file set is decided, and that is the whole reason
 * both exist: a `files` link pins the paths, so a contract added upstream is invisible until
 * somebody edits the link, while a `folder` link re-discovers the set on every sync. Pointing
 * at a folder is therefore the right shape for a spec directory that grows, and naming files is
 * the right shape for picking two documents out of a repo that is mostly something else.
 */
export const foundationalServiceSourceModeSchema = v.picklist(['directory', 'folder', 'files'])
export type FoundationalServiceSourceMode = v.InferOutput<
  typeof foundationalServiceSourceModeSchema
>

/** A repo linked as a source of foundational-service definitions. */
export const foundationalServiceSourceSchema = v.object({
  id: v.string(),
  ownerKind: foundationalServiceOwnerKindSchema,
  ownerId: v.string(),
  repoOwner: v.string(),
  repoName: v.string(),
  gitRef: v.string(),
  mode: foundationalServiceSourceModeSchema,
  /** Subtree scanned in `directory`/`folder` mode; the anchor for the head-commit probe in all. */
  dirPath: v.string(),
  /**
   * `folder` mode only: whether the scan descends into `dirPath`'s subfolders. False elsewhere —
   * `directory` mode's subdirectories are its services and `files` mode enumerates paths.
   */
  recursive: v.boolean(),
  /** `files` mode only: the contract files, repo-root-relative. Empty in the folder modes. */
  filePaths: v.array(v.string()),
  /** `folder`/`files` mode: the service the linked contracts describe. Null in `directory` mode. */
  serviceId: v.nullable(v.string()),
  serviceName: v.nullable(v.string()),
  serviceSummary: v.nullable(v.string()),
  lastSyncedCommit: v.nullable(v.string()),
  lastSyncedAt: v.nullable(v.number()),
  createdAt: v.number(),
})
export type FoundationalServiceSource = v.InferOutput<typeof foundationalServiceSourceSchema>

/** Link a repo directory, a whole folder, or an explicit file list as a foundational source. */
export const linkFoundationalServiceSourceSchema = v.pipe(
  v.object({
    repoOwner: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
    repoName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
    /** Git ref to read; defaults to the repo's default branch (`HEAD`). */
    gitRef: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
    mode: foundationalServiceSourceModeSchema,
    dirPath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(300))),
    /** `folder` mode: descend into `dirPath`'s subfolders too. Defaults to false. */
    recursive: v.optional(v.boolean()),
    filePaths: v.optional(
      v.pipe(
        v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300))),
        v.maxLength(50),
      ),
    ),
    serviceId: v.optional(slug),
    serviceName: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
    serviceSummary: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400))),
  }),
  // Neither single-service mode carries a directory convention to read identity from, so the
  // link MUST name the service its contracts describe. Refused at the write boundary rather
  // than discovered at sync time, where the only honest outcome would be a source that
  // permanently syncs nothing.
  v.check(
    (input) =>
      (input.mode !== 'files' && input.mode !== 'folder') ||
      (!!input.serviceId && !!input.serviceName),
    'a `folder` or `files` source must name serviceId and serviceName',
  ),
  v.check(
    (input) => input.mode !== 'files' || (input.filePaths?.length ?? 0) > 0,
    'a `files` source must list at least one file path',
  ),
  // `recursive` is meaningful only where a subtree is scanned for ONE service's contracts. In
  // `directory` mode the subdirectories ARE the services and in `files` mode the paths are
  // enumerated, so accepting it there would store a flag that silently does nothing.
  v.check(
    (input) => input.mode === 'folder' || !input.recursive,
    '`recursive` applies only to a `folder` source',
  ),
)
export type LinkFoundationalServiceSourceInput = v.InferOutput<
  typeof linkFoundationalServiceSourceSchema
>

/**
 * How much of a `folder` source's folder its walk actually covered.
 *
 * A DISCRIMINATED value rather than a pair of booleans, because the three states are mutually
 * exclusive and each needs a different fix from whoever linked the source: nothing (re-point the
 * link), a prefix (narrow the folder or split the service), or all of it (nothing to do). They
 * also carry different dispositions inside the sync — see the reconcile — so a shape that could
 * express two of them at once would be a shape that can lie.
 */
export const folderScanCoverageSchema = v.picklist([
  /** The walk saw the whole folder. */
  'complete',
  /**
   * A scan CAP stopped the walk short (depth, directories visited, or contract files taken), so
   * the contract set is a PREFIX of what the folder holds. Never a transient: a truncated pass
   * that still produced contracts pins its commit, because re-reading would truncate identically
   * and the source would never look caught up.
   */
  'truncated',
  /**
   * The folder itself is not there. Git cannot represent an empty directory, so a root listing
   * with no entries at all means the path is absent upstream — renamed, deleted, or mistyped at
   * link time — rather than an empty spec folder. Reported separately precisely because the two
   * read identically (zero contracts) and need opposite reactions from a human.
   */
  'missing',
])
export type FolderScanCoverage = v.InferOutput<typeof folderScanCoverageSchema>

/** Outcome of resyncing a source: counts of changed/removed/unchanged services. */
export const foundationalServiceSyncResultSchema = v.object({
  upserted: v.number(),
  tombstoned: v.number(),
  unchanged: v.number(),
  lastSyncedCommit: v.nullable(v.string()),
  /**
   * Files that LOOKED like contract documents (an OpenAPI or contract-module extension) but did
   * not become one this pass — unreadable, unrecognised content, or a duplicate contract id.
   * Zero and "nothing was scanned" are told apart by the counts above, and a non-zero value is
   * the only thing that explains a folder link that produced fewer contracts than its author
   * expected. Files with no contract extension are never read and never counted.
   */
  skippedFiles: v.number(),
  /**
   * How much of the folder a `folder` source's walk covered, or NULL for the modes that run no
   * walk at all. Null is a real third answer rather than a stand-in for `complete`: a `files`
   * source did not scan a folder completely, it never scanned one.
   */
  folderScan: v.nullable(folderScanCoverageSchema),
})
export type FoundationalServiceSyncResult = v.InferOutput<
  typeof foundationalServiceSyncResultSchema
>

/** Lightweight "check for changes" result (no writes) — one head-commit probe. */
export const foundationalServiceSourceStatusSchema = v.object({
  changed: v.boolean(),
  lastSyncedCommit: v.nullable(v.string()),
  remoteCommit: v.nullable(v.string()),
})
export type FoundationalServiceSourceStatus = v.InferOutput<
  typeof foundationalServiceSourceStatusSchema
>

/**
 * What the Architect DECLARED it designed against, recorded on its step.
 *
 * `declared` are ids that resolved against the catalog; `unknown` are ids the agent named
 * that did not. The two are kept APART on purpose: an unknown id is a design that leans on a
 * service the platform cannot hand anyone the contract for, and collapsing it into `declared`
 * would surface downstream as a service whose API details are silently missing.
 */
export const foundationalServiceSelectionSchema = v.object({
  declared: v.array(v.string()),
  unknown: v.array(v.string()),
})
export type FoundationalServiceSelection = v.InferOutput<typeof foundationalServiceSelectionSchema>
