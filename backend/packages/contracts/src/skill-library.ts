import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Wire contracts for the repo-sourced Claude Skills library
// (ADR 0024). An account links a repo directory of skill
// folders (`<skill>/SKILL.md` + sibling resources); the link is synced into the
// account's skill catalog, shared across its workspaces. These shapes back the
// account-settings management UI (link/sync/status) and, later, the palette
// picker (slice 3) and the executable `skill` step (slice 2).
// ---------------------------------------------------------------------------

/**
 * The GROUPS a skill declares itself into — the kind of work its playbook does, so a surface
 * offering skills can offer only the ones that FIT it (the review-task queue offers `review`
 * skills, and nothing else). Declared in `SKILL.md` frontmatter as `group: review`; a manifest
 * that declares none, or declares a value this build does not know, reads as `other`.
 *
 * Closed, and deliberately COARSE: these are shelves in a picker, not a taxonomy. A team's
 * "Performance Review" and "Security Review" playbooks both shelve under `review`; what
 * distinguishes them is their name and description, which is what the picker shows.
 *
 * The vocabulary is PERSISTED (a synced row carries the value its manifest declared), so a
 * reader must narrow with {@link isSkillGroup} rather than assume this build's members are the
 * only ones a row can hold. Retiring a member therefore does NOT remove it from the database:
 * {@link normalizeSkillGroup} lands such a row on `other` (the unclassified shelf), and the
 * management surface states the declared value beside it, so an author sees what they wrote
 * rather than silently losing a shelf.
 */
export const SKILL_GROUPS = [
  'build',
  'review',
  'test',
  'write',
  'plan',
  'operate',
  'other',
] as const
export const skillGroupSchema = v.picklist(SKILL_GROUPS)
export type SkillGroup = v.InferOutput<typeof skillGroupSchema>

const SKILL_GROUP_SET: ReadonlySet<string> = new Set(SKILL_GROUPS)

/**
 * Whether a value is a group THIS BUILD knows, DERIVED from the picklist so it cannot drift from
 * it the way a hand-written second list would (the `isAgentCategory` shape, for the same reason:
 * the values reaching a reader are not this build's alone).
 */
export function isSkillGroup(value: string): value is SkillGroup {
  return SKILL_GROUP_SET.has(value)
}

/**
 * The shelf a raw declared group lands on: itself when this build knows it, `other` otherwise.
 * Case- and whitespace-insensitive, because the value comes from hand-authored frontmatter.
 *
 * Never throws and never guesses a neighbour: `security` is not silently read as `review`,
 * because nothing knows which shelf the author meant, and a wrong shelf is what would put a
 * playbook in front of the wrong step.
 */
export function normalizeSkillGroup(raw: string | null | undefined): SkillGroup {
  const value = (raw ?? '').trim().toLowerCase()
  return isSkillGroup(value) ? value : 'other'
}

/** A stored group as a reader must present it: the shelf, plus the raw value when it is unknown. */
export interface SkillGroupView {
  /** The shelf to compare and filter on ({@link normalizeSkillGroup}). */
  group: SkillGroup
  /** What was declared, present ONLY when this build does not know it. */
  declaredGroup?: string
}

/**
 * Read a STORED group: the shelf it lands on, and the declared value when that is not a member
 * this build knows. The two halves are answered together because they are one decision, and a
 * reader that computed the shelf without the echo would reclassify in silence.
 *
 * Total over an ABSENT value, which is not defensive padding: the record crosses the
 * `/internal/persistence` RPC in mothership mode, where a peer one build behind is the normal
 * state of running one and simply does not send the field. `undefined` is the honest "declared
 * nothing we can see", which is the `other` shelf with nothing to echo. Anything else would make
 * the account's skill library 500 on a version skew it is designed to tolerate.
 */
export function describeSkillGroup(raw: string | null | undefined): SkillGroupView {
  const declared = (raw ?? '').trim().toLowerCase()
  const group = normalizeSkillGroup(declared)
  return declared && !isSkillGroup(declared) ? { group, declaredGroup: declared } : { group }
}

/**
 * `error.details.reason` on the 422 a skill resolver raises for an id the account's catalog no
 * longer holds (removed upstream, or its source unlinked). Machine-readable precisely so the
 * layer that knows WHERE the id was picked can recognise this refusal and append the remedy
 * naming that surface, while an infrastructure failure on the same call path (an unreachable
 * store, a lost RPC) propagates as itself: an outage is not a misconfiguration, and telling an
 * operator to go re-pick a skill because a database blinked sends them to fix nothing.
 */
export const SKILL_UNAVAILABLE_REASON = 'skill_unavailable'

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
  /** The shelf this skill sits on, normalized from its manifest ({@link normalizeSkillGroup}). */
  group: skillGroupSchema,
  /**
   * What the manifest actually declared, present ONLY when it is not a group this build knows
   * (a typo, or a retired member still on the row). The management surface renders it beside the
   * `other` shelf so the author sees the value they wrote instead of a silent reclassification.
   */
  declaredGroup: v.optional(v.string()),
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
 * builder's skill picker and the review task's skill queue (id + name + description + group —
 * NOT the full `instructions` / resource manifest, which would bloat every board load). The account catalog is shared across the
 * account's workspaces, so this is the account's skills served through the catalog cache in one
 * read (see ADR 0024 "No N+1"). The account-settings management surface
 * fetches the full {@link AccountSkill} via `GET /accounts/:accountId/skills` instead.
 */
export const skillSummarySchema = v.object({
  id: v.string(),
  name: v.string(),
  description: v.string(),
  /**
   * The shelf the skill sits on, already normalized — so a surface offering a SUBSET of the
   * catalog (the review task queues `review` skills) filters on a value it can compare directly
   * rather than re-deriving the classification the backend already made.
   */
  group: skillGroupSchema,
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
