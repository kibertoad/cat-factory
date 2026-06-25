import * as v from 'valibot'
import { agentKindSchema, blockTypeSchema } from './primitives.js'
import { promptFragmentSchema } from './entities.js'
import { documentSourceKindSchema } from './documents.js'

// ---------------------------------------------------------------------------
// Wire contracts for the tenant-scoped prompt-fragment library (ADR 0006). A
// resolved catalog for a workspace is the merge of three tiers — built-in,
// account, workspace — later tiers overriding earlier ones by stable id. Teams
// curate fragments by hand or link a repo of Markdown guidelines; the catalog is
// then selected from per run. These shapes back the management UI and the
// resolved read the run path uses.
// ---------------------------------------------------------------------------

/** Which scope owns a managed fragment / source: an account, or a workspace. */
export const fragmentOwnerKindSchema = v.picklist(['account', 'workspace'])
export type FragmentOwnerKind = v.InferOutput<typeof fragmentOwnerKindSchema>

/** The three tiers a resolved fragment can originate from, lowest-precedence first. */
export const fragmentTierSchema = v.picklist(['builtin', 'account', 'workspace'])
export type FragmentTier = v.InferOutput<typeof fragmentTierSchema>

const appliesToSchema = v.object({
  blockTypes: v.optional(v.array(blockTypeSchema)),
  agentKinds: v.optional(v.array(agentKindSchema)),
})

const tagsSchema = v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40)))

/** Create a hand-authored fragment at a tier. `id` defaults to a slug of the title. */
export const createPromptFragmentSchema = v.object({
  id: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  category: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(100))),
  summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(20000)),
  tags: v.optional(tagsSchema),
  appliesTo: v.optional(appliesToSchema),
  /** Semver of the body; defaults to `1.0.0`. */
  version: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40))),
})
export type CreatePromptFragmentInput = v.InferOutput<typeof createPromptFragmentSchema>

/** Edit a fragment's body/metadata. Every field is optional (a partial patch). */
export const updatePromptFragmentSchema = v.object({
  title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  category: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(100))),
  summary: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))),
  body: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(20000))),
  tags: v.optional(tagsSchema),
  appliesTo: v.optional(appliesToSchema),
  version: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40))),
})
export type UpdatePromptFragmentInput = v.InferOutput<typeof updatePromptFragmentSchema>

/**
 * Link an external document (a Confluence/Notion page or a GitHub file) as a
 * **living** best-practice fragment: its title/body are fetched from the source
 * now (to seed the catalog entry) and re-resolved at run time. The caller-facing
 * metadata is optional; the title, summary and body are derived from the fetched
 * document, never supplied here.
 */
export const createDocumentFragmentSchema = v.object({
  source: documentSourceKindSchema,
  /** A page id or full page/file URL, resolved by the source's provider. */
  ref: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  id: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  category: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(100))),
  tags: v.optional(tagsSchema),
  appliesTo: v.optional(appliesToSchema),
  /**
   * For an account-tier link only: the workspace whose stored connection is used
   * to perform the initial fetch (document-source credentials are per-workspace).
   * Ignored at the workspace scope, where the addressed workspace is used.
   */
  viaWorkspaceId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
})
export type CreateDocumentFragmentInput = v.InferOutput<typeof createDocumentFragmentSchema>

/** A repo a tier links as a source of Markdown guideline files. */
export const fragmentSourceSchema = v.object({
  id: v.string(),
  ownerKind: fragmentOwnerKindSchema,
  ownerId: v.string(),
  repoOwner: v.string(),
  repoName: v.string(),
  gitRef: v.string(),
  dirPath: v.string(),
  /** Digest of the source tree at the last successful sync; null if never synced. */
  lastSyncedSha: v.nullable(v.string()),
  lastSyncedAt: v.nullable(v.number()),
  createdAt: v.number(),
})
export type FragmentSource = v.InferOutput<typeof fragmentSourceSchema>

/** Link a repo directory as a fragment source. */
export const linkFragmentSourceSchema = v.object({
  repoOwner: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  repoName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  /** Git ref to read; defaults to the repo's default branch (`HEAD`). */
  gitRef: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  /** Subtree to read (e.g. `guidelines`); defaults to the repo root. */
  dirPath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(300))),
})
export type LinkFragmentSourceInput = v.InferOutput<typeof linkFragmentSourceSchema>

/** Outcome of resyncing a source: counts of changed/removed/unchanged files. */
export const fragmentSyncResultSchema = v.object({
  upserted: v.number(),
  tombstoned: v.number(),
  unchanged: v.number(),
  lastSyncedSha: v.nullable(v.string()),
})
export type FragmentSyncResult = v.InferOutput<typeof fragmentSyncResultSchema>

/** Cheap "check for changes" result (no writes); powers the resync badge. */
export const fragmentSourceStatusSchema = v.object({
  changed: v.boolean(),
  changedCount: v.number(),
  lastSyncedSha: v.nullable(v.string()),
  remoteSha: v.nullable(v.string()),
})
export type FragmentSourceStatus = v.InferOutput<typeof fragmentSourceStatusSchema>

/** A fragment as seen after the three tiers are merged for a workspace. */
export const resolvedFragmentSchema = v.object({
  ...promptFragmentSchema.entries,
  /** Which tier this resolved entry came from after override-by-id. */
  tier: fragmentTierSchema,
})
export type ResolvedFragment = v.InferOutput<typeof resolvedFragmentSchema>

/** The merged catalog as served by `GET /workspaces/:id/prompt-fragments/resolved`. */
export const resolvedFragmentCatalogSchema = v.array(resolvedFragmentSchema)
export type ResolvedFragmentCatalog = v.InferOutput<typeof resolvedFragmentCatalogSchema>
