import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Wire contracts for the repo-sourced Claude Skills library
// (docs/initiatives/repo-skills.md). An account links a repo directory of skill
// folders (`<skill>/SKILL.md` + sibling resources); the link is synced into the
// account's skill catalog, shared across its workspaces. These shapes back the
// account-settings management UI (link/sync/status) and, later, the palette
// picker (slice 3) and the executable `skill` step (slice 2).
// ---------------------------------------------------------------------------

/** One sibling resource file of a skill (manifest only — no body on the wire). */
export const skillResourceSchema = v.object({
  path: v.string(),
  sha: v.string(),
  size: v.number(),
})
export type SkillResource = v.InferOutput<typeof skillResourceSchema>

/** A repo-sourced skill as seen by the account management surface / picker. */
export const accountSkillSchema = v.object({
  /** Stable id — `src:<sourceId>:<dirName>`. */
  id: v.string(),
  name: v.string(),
  description: v.string(),
  /** The procedural instructions (the `SKILL.md` body). */
  instructions: v.string(),
  resources: v.array(skillResourceSchema),
  /** Provenance: the source + `SKILL.md` path + blob sha it was synced from. */
  source: v.object({ sourceId: v.string(), path: v.string(), sha: v.string() }),
  /** Head commit the skill was pinned to at the last sync; null if never synced. */
  pinnedCommit: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type AccountSkill = v.InferOutput<typeof accountSkillSchema>

/**
 * The lightweight per-skill projection carried in the workspace snapshot for the pipeline
 * builder's skill picker (id + name + description only — NOT the full `instructions` / resource
 * manifest, which would bloat every board load). The account catalog is shared across the
 * account's workspaces, so this is the account's skills served through the catalog cache in one
 * read (see docs/initiatives/repo-skills.md "No N+1"). The account-settings management surface
 * fetches the full {@link AccountSkill} via `GET /accounts/:accountId/skills` instead.
 */
export const skillSummarySchema = v.object({
  id: v.string(),
  name: v.string(),
  description: v.string(),
})
export type SkillSummary = v.InferOutput<typeof skillSummarySchema>

/** A repo directory an account links as a source of skill folders. */
export const skillSourceSchema = v.object({
  id: v.string(),
  accountId: v.string(),
  repoOwner: v.string(),
  repoName: v.string(),
  gitRef: v.string(),
  dirPath: v.string(),
  /** Head commit sha of the source dir at the last successful sync; null if never synced. */
  lastSyncedCommit: v.nullable(v.string()),
  lastSyncedAt: v.nullable(v.number()),
  createdAt: v.number(),
})
export type SkillSource = v.InferOutput<typeof skillSourceSchema>

/** Link a repo directory as a skill source. */
export const linkSkillSourceSchema = v.object({
  repoOwner: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  repoName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  /** Git ref to read; defaults to the repo's default branch (`HEAD`). */
  gitRef: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  /** Subtree to scan for `<skill>/SKILL.md` folders (e.g. `.claude/skills`); defaults to root. */
  dirPath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(300))),
})
export type LinkSkillSourceInput = v.InferOutput<typeof linkSkillSourceSchema>

/** Outcome of resyncing a source: counts of changed/removed/unchanged skills. */
export const skillSyncResultSchema = v.object({
  upserted: v.number(),
  tombstoned: v.number(),
  unchanged: v.number(),
  /** Head commit sha the source dir was synced to. */
  lastSyncedCommit: v.nullable(v.string()),
})
export type SkillSyncResult = v.InferOutput<typeof skillSyncResultSchema>

/**
 * Lightweight "check for changes" result (no writes); powers the resync badge. A
 * single commit-version probe: `changed` is true when the source dir's current head
 * commit differs from the one it was last synced to.
 */
export const skillSourceStatusSchema = v.object({
  changed: v.boolean(),
  /** Head commit sha at the last successful sync; null if never synced. */
  lastSyncedCommit: v.nullable(v.string()),
  /** The source dir's current head commit sha upstream; null if the dir has no commits. */
  remoteCommit: v.nullable(v.string()),
})
export type SkillSourceStatus = v.InferOutput<typeof skillSourceStatusSchema>
