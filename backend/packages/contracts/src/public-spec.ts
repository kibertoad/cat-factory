import * as v from 'valibot'
import { vcsProviderSchema } from './routes/auth.js'
import { specDocSchema, specReadIssueSchema } from './spec.js'

// ---------------------------------------------------------------------------
// The public read of a service's in-repo SPECIFICATION (`GET /api/v1/services/:serviceId/spec`).
//
// The spec is the platform's requirements truth: structured requirement items with a MoSCoW
// priority, an `aspirational ⇄ established` lifecycle state and Gherkin-shaped acceptance
// criteria, stored in the service's own repository under `spec/`. Three consumers could already
// read it (agents through the repo-ops, humans through the app's requirements window, and anyone
// holding VCS credentials through a checkout), and the one that could not was the headless
// integrator holding only a cat-factory API key. That is the consumer this exists for: an
// outcome-reviewing tool can fetch a run's report and, with this, the criteria the report scored
// against, which is a key lookup on the requirement id rather than a repository clone.
//
// Four decisions shape the shape:
//
//  1. **The tree is served as the SAME `SpecDoc` the app's window consumes**, not a re-projection.
//     A second wire shape over one artifact is two things to keep in step, and the requirement id
//     is the join key onto the run report either way. The cost is real and stated rather than
//     hidden: `SpecDoc` and everything under it become part of the STABLE `/api/v1` surface the
//     moment this ships, so those schemas leave the "internals are freely breakable" half of
//     CLAUDE.md and join the half that needs a migration path. That is a price worth paying once,
//     and cheaper than two shapes drifting.
//  2. **A read has four outcomes and this shape refuses to fold them.** The internal view collapses
//     "no spec on this branch" and "we could not read the repo" into one `present: false`, which
//     is right for a window rendering an empty state and wrong for an integrator: it would report
//     every service as requirement-free for the duration of a VCS incident. Here an unwired VCS
//     capability and a failed read are each a `503` carrying their own `details.reason`, an absent
//     spec is `present: false`, and a spec that read PARTIALLY is served with {@link
//     PublicServiceSpec.issues} naming each file that did not survive.
//  3. **Provenance, because this is a snapshot and not a subscription.** The spec on the default
//     branch is not the spec a run with an open pull request is working against, so the response
//     names the ref and the commit it describes rather than implying a liveness it does not have.
//  4. **Every cap is reported.** Both unbounded axes (the requirement/rule rows and the rendered
//     Gherkin) are bounded, and each bound states what it left out, so a capped response can never
//     read as a shorter spec. Same rule the debug surface is built on.
//
// There is deliberately NO write side. The files are the truth and the write path is a REVIEWED
// commit: agents propose spec changes through pull requests and the tester-driven promotion post-op
// remains the one author of `state`. An API write would bypass exactly the review that makes the
// spec trustworthy, so its absence is a decision rather than a gap.
// ---------------------------------------------------------------------------

/** Ceiling on requirement rows one response may carry, across the whole tree. */
export const PUBLIC_SPEC_MAX_REQUIREMENTS = 2_000

/** Ceiling on domain-rule rows one response may carry, across the whole tree. */
export const PUBLIC_SPEC_MAX_RULES = 2_000

/** Ceiling on how many rendered `.feature` files one response may carry. */
export const PUBLIC_SPEC_MAX_FEATURE_FILES = 500

/** Ceiling on the characters of Gherkin ONE feature file may carry. */
export const PUBLIC_SPEC_MAX_FEATURE_CHARS = 20_000

/**
 * Where the served tree was read from, and WHEN.
 *
 * `commit` is the head of `ref` resolved immediately before the walk, and it is nullable for one
 * honest reason: the tree is read BY BRANCH NAME (that is what makes the reads cacheable and
 * cheap), so a push landing mid-walk can leave the response describing a slightly later commit
 * than the one named. A null means the head could not be resolved at all: the tree below is still
 * what the branch held, we simply cannot name the commit.
 *
 * There is no `directory` here, and its absence is the fact: the `spec/` tree is anchored at the
 * REPOSITORY ROOT, so two services carved out of one monorepo share one spec. Naming a
 * subdirectory would imply a scoping the reader does not apply.
 */
export const publicSpecProvenanceSchema = v.object({
  provider: vcsProviderSchema,
  /** The repository's owner (org or user). */
  owner: v.string(),
  /** The repository's name. */
  repo: v.string(),
  /** The branch the spec was read from: the repository's default branch. */
  ref: v.string(),
  /** The head commit of `ref` at read time, or null when it could not be resolved. */
  commit: v.nullable(v.string()),
})
export type PublicSpecProvenance = v.InferOutput<typeof publicSpecProvenanceSchema>

/**
 * One rendered Gherkin feature file, bounded.
 *
 * `chars`/`totalChars`/`truncated` are the debug surface's own shape, for its own reason: a bare
 * truncated string is indistinguishable from a short one, so a reader would confidently conclude
 * a feature declares two scenarios from a payload that merely hit its budget.
 */
export const publicSpecFeatureFileSchema = v.object({
  /** The owning module's display name. */
  module: v.string(),
  /** The feature/group display name. */
  group: v.string(),
  /** Repo-relative path of the `.feature` file. */
  path: v.string(),
  /** The Gherkin, clamped to {@link PUBLIC_SPEC_MAX_FEATURE_CHARS}. */
  content: v.string(),
  /** Characters actually returned in `content`. */
  chars: v.number(),
  /** Characters the file holds in the repository, whatever was returned. */
  totalChars: v.number(),
  /** True when `chars < totalChars`. */
  truncated: v.boolean(),
})
export type PublicSpecFeatureFile = v.InferOutput<typeof publicSpecFeatureFileSchema>

/** Which axis a cap bit on. Every member counts ITEMS, so `shown`/`total` share one unit. */
export const publicSpecTruncationSectionSchema = v.picklist(['requirements', 'rules', 'features'])
export type PublicSpecTruncationSection = v.InferOutput<typeof publicSpecTruncationSectionSchema>

/**
 * One cap that bit, and by how much. Present only for an axis that was actually shortened, so an
 * empty `truncations` means the tree below is complete.
 *
 * The cap is applied in the tree's own traversal order (module, then group, then declaration
 * order), which is stated so a reader does not have to guess: the rows that were dropped are the
 * ones latest in that order, not the least important ones. Nothing here RANKS requirements.
 */
export const publicSpecTruncationSchema = v.object({
  section: publicSpecTruncationSectionSchema,
  /** How many rows the response carries. */
  shown: v.number(),
  /** How many rows the spec holds. */
  total: v.number(),
})
export type PublicSpecTruncation = v.InferOutput<typeof publicSpecTruncationSchema>

/**
 * The service's specification as `/api/v1` serves it.
 *
 * `present: false` means exactly one thing here: the service's repository holds no
 * `spec/service.json` on its default branch. It never means the repository could not be read (a
 * `503` with `reason: "spec_read_failed"`), that no repository is linked (a `422`), or that this
 * deployment wired no VCS integration (a `503` with `reason: "vcs_not_configured"`).
 */
export const publicServiceSpecSchema = v.object({
  /** The board service frame this spec belongs to, echoed so a response stands alone. */
  serviceId: v.string(),
  /** Whether the default branch holds a spec at all. */
  present: v.boolean(),
  /** The structured tree (modules → groups → requirements + rules), or null when absent. */
  spec: v.nullable(specDocSchema),
  /** The rendered Gherkin, one entry per `.feature` file. Empty when the repo renders none. */
  features: v.array(publicSpecFeatureFileSchema),
  provenance: publicSpecProvenanceSchema,
  /**
   * Files the read could not fully account for: a provider error on one shard, a shard whose JSON
   * is unusable, a group salvaged with some requirements dropped. A present-but-partial spec is
   * served rather than refused, and this is what stops the part that arrived reading as the whole.
   */
  issues: v.array(specReadIssueSchema),
  /** Every cap that bit. Empty when nothing was left out. */
  truncations: v.array(publicSpecTruncationSchema),
})
export type PublicServiceSpec = v.InferOutput<typeof publicServiceSpecSchema>
