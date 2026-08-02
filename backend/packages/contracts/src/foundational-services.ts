import * as v from 'valibot'
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
// Registration is TIERED exactly like the prompt-fragment library: an `account` row is
// shared by every workspace in the account, a `workspace` row wins over it by id. The
// resolved catalog is what the Architect sees; the contract BODIES are read lazily,
// only for the services the Architect declared, and only by the downstream kinds that
// need them.
// ---------------------------------------------------------------------------

/** Which scope owns a foundational service / source: an account, or a workspace. */
export const foundationalServiceOwnerKindSchema = fragmentOwnerKindSchema
export type FoundationalServiceOwnerKind = v.InferOutput<typeof foundationalServiceOwnerKindSchema>

/** The tier a resolved catalog entry originated from, lowest-precedence first. */
export const foundationalServiceTierSchema = v.picklist(['account', 'workspace'])
export type FoundationalServiceTier = v.InferOutput<typeof foundationalServiceTierSchema>

/**
 * The API-contract document formats the catalog accepts. Each is stored verbatim as text;
 * only OpenAPI is additionally PARSED (into an operation index the lazy read renders as a
 * compact summary) because the other two are TypeScript modules, which cannot be evaluated
 * in a Worker isolate and are handed to the agent as source.
 */
export const apiContractFormatSchema = v.picklist([
  /** An OpenAPI 3.x document, JSON or YAML. */
  'openapi',
  /** A module built on `@toad-contracts/core` (`defineApiContract(...)`). */
  'toad-contract',
  /** A module built on `@lokalise/api-contract` (`buildPayloadRoute` / `buildGetRoute` …). */
  'lokalise-api-contract',
])
export type ApiContractFormat = v.InferOutput<typeof apiContractFormatSchema>

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
   * The operations an OpenAPI document declares (`GET /files/{id}` …), capped. Empty for the
   * TypeScript formats, which are not parsed. Cheap enough to ride the catalog and it is what
   * makes the catalog actionable — an architect can name the endpoint it intends to call.
   */
  operations: v.array(v.string()),
  /**
   * How many operations were dropped from {@link operations} by the cap. Non-zero says the
   * list is a PREFIX, so a reader never concludes the tail does not exist.
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

/** A resolved (account ⊕ workspace merged) catalog entry, carrying its winning tier. */
export const resolvedFoundationalServiceSchema = v.object({
  ...foundationalServiceSchema.entries,
  tier: foundationalServiceTierSchema,
})
export type ResolvedFoundationalService = v.InferOutput<typeof resolvedFoundationalServiceSchema>

/**
 * One SUPPRESSION a board is asserting: an id its workspace tier tombstones, so the account
 * service of that id loses the merge.
 *
 * A suppressed id is by construction absent from the merged catalog, which is what makes this a
 * separate read rather than a flag on it — without it the management surface could offer no way
 * back, and suppression would be a one-way door.
 *
 * `inherited` is the honest half: `false` says the tombstone currently shadows NOTHING (the
 * account withdrew the service, or the board deleted its own registration), so a reader does not
 * conclude a capability is being withheld when there is none to withhold. The name is the
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
export const createFoundationalServiceSchema = v.object({
  id: slug,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400)),
  description: v.pipe(v.string(), v.trim(), v.maxLength(20_000)),
  capabilities: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)))),
  contracts: v.optional(v.array(uploadApiContractSchema)),
})
export type CreateFoundationalServiceInput = v.InferOutput<typeof createFoundationalServiceSchema>

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
