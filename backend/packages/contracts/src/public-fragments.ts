import * as v from 'valibot'
import { fragmentTierSchema } from './fragment-library.js'
import { blockTypeSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// The PUBLIC best-practice-standard surface: what `GET /api/v1/prompt-fragments` serves, and the
// vocabulary `createPublicTaskSchema.fragmentIds` is checked against.
//
// The same gap the task-type descriptors closed, one field along. A task's standards were
// selectable from the app and from the internal API and nowhere else, so a headless caller filing
// a review could name the pull request, the focus and the pipeline, and could not say which of the
// team's own standards the reviewer was to judge it against. What it got instead was whatever the
// enclosing service happens to carry, which is the right default and the wrong ANSWER for a caller
// that has a reason to pick (a security sweep, a migration, a repository whose standards differ
// from its service's).
//
// This is a PROJECTION of the merged catalog (built-in ∪ account ∪ workspace, override-by-id,
// tombstones applied), not the catalog rows: it carries the metadata a picker decides from and NOT
// the `body`, which is the guidance text itself. That split is the reason the read sits at `read`
// rather than at the `admin` its sibling libraries take: what a caller needs in order to name a
// standard is the standard's identity, and the authored text of an org's engineering guidelines is
// a different thing to publish than a list of what it has written down.
//
// It is also exactly the shape the platform's OWN relevance selector picks from (kernel's
// `SelectableFragment`), plus the tier and version a person reads. So a caller choosing standards
// here decides from the same facts the automatic selection decides from, rather than from a
// summary of them.
// ---------------------------------------------------------------------------

/**
 * Which kinds of work a standard is a suggested fit for. A picker HINT, never a gate: nothing
 * refuses a standard whose `appliesTo` does not name the task it is pinned onto, and the platform's
 * own management surface uses it to narrow what it offers rather than to decide what a run folds.
 *
 * Published as open strings on the agent-kind side, like `publicRunStep.agentKind` and for the same
 * reason: a deployment registers its own kinds, so a closed list here would report a custom
 * reviewer's standards as applying to nothing. The block types are the same closed vocabulary
 * `publicService.type` already publishes.
 */
export const publicFragmentAppliesToSchema = v.object({
  blockTypes: v.optional(v.array(blockTypeSchema)),
  agentKinds: v.optional(v.array(v.string())),
})
export type PublicFragmentAppliesTo = v.InferOutput<typeof publicFragmentAppliesToSchema>

/** One best-practice standard the key's workspace resolves, as a caller picking one reads it. */
export const publicPromptFragmentSchema = v.object({
  /** The stable id (`node.performance`, `acme.security-review`) a task pins as a `fragmentIds` member. */
  fragmentId: v.string(),
  /** The human title, which is also the label an agent cites the standard by in its findings. */
  title: v.string(),
  /** The grouping label a picker renders under (`Node`, `React`, an org's own heading). */
  category: v.string(),
  /** One line saying what the standard demands. What the automatic relevance selector reads. */
  summary: v.string(),
  /** Semver of the body, so a caller can tell a re-worded standard from a re-authored one. */
  version: v.string(),
  /**
   * Which tier this entry won on: the deployment's shipped catalog, the account's library, or this
   * workspace's own. Served because the three need different fixes when a standard is wrong, and a
   * caller cannot otherwise tell an org standard it should not touch from one this board authored.
   */
  tier: fragmentTierSchema,
  /** Free-form tags the library carries; empty for an entry that has none. */
  tags: v.array(v.string()),
  /** The picker hint, when the entry declares one. See {@link publicFragmentAppliesToSchema}. */
  appliesTo: v.optional(publicFragmentAppliesToSchema),
})
export type PublicPromptFragment = v.InferOutput<typeof publicPromptFragmentSchema>

/** The merged catalog as `GET /api/v1/prompt-fragments` serves it. */
export const publicPromptFragmentListSchema = v.object({
  fragments: v.array(publicPromptFragmentSchema),
})
export type PublicPromptFragmentList = v.InferOutput<typeof publicPromptFragmentListSchema>

/**
 * Standards ONE task creation may name.
 *
 * It bounds the REQUEST, not what the run folds: the service's standing standards and the task
 * type's own defaults union on top of this list and are not counted against it, so a cap here
 * could never be the thing that keeps a prompt small. What keeps a prompt small is the fold itself
 * (an implementer kind gets each standard's condensed `brief`), which is the platform's business
 * and not a number a caller can act on.
 *
 * So it is set an order of magnitude above the shipped catalog rather than tuned: a public write
 * that accepts an unbounded array is a hole every neighbouring field on this surface has closed,
 * and no real selection reaches this.
 */
export const MAX_TASK_FRAGMENTS = 100
