import * as v from 'valibot'
import { vcsProviderSchema } from './routes/auth.js'
import { readSpecDocSchema, specReadIssueSchema } from './spec.js'

// ---------------------------------------------------------------------------
// The public reads of the in-repo SPECIFICATION: a service's, from the repository's default branch
// (`GET /api/v1/services/:serviceId/spec`), and a run's, from the branch that run pushed its work
// to (`GET /api/v1/runs/:runId/spec`). Everything below describes the first; the second carries the
// same body at a different ref, and {@link publicRunSpecSchema} states what it changes and why.
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
//     capability and a failed read are each a `503` carrying their own `details.reason`, what the
//     branch holds is the three-valued {@link PublicServiceSpec.anchor}, and a spec that read
//     PARTIALLY is served with {@link PublicServiceSpec.issues} naming each file that did not
//     survive.
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

/**
 * Ceiling on acceptance criteria one response may carry, across the whole tree.
 *
 * Across the tree rather than per requirement, because a per-item cap does not bound anything: a
 * criterion carries three 2,000-character clauses, so twenty of them on each of 2,000 requirements
 * is a response two orders of magnitude past every other cap here. The row caps bound the tree's
 * SHAPE; this bounds the part of its WEIGHT they do not.
 */
export const PUBLIC_SPEC_MAX_ACCEPTANCE = 5_000

/** Ceiling on how many rendered `.feature` files one response may carry. */
export const PUBLIC_SPEC_MAX_FEATURE_FILES = 500

/** Ceiling on the characters of Gherkin ONE feature file may carry. */
export const PUBLIC_SPEC_MAX_FEATURE_CHARS = 20_000

/**
 * Ceiling on the characters of Gherkin ALL feature files may carry, together.
 *
 * The per-file cap alone bounds nothing that matters: 500 files each clamped to 20,000 characters
 * is a ten-megabyte body served to a `read`-scope key. Spent in the same traversal order as every
 * other budget, so a file is whole, clamped, or absent, and never a sample.
 */
export const PUBLIC_SPEC_MAX_FEATURE_TOTAL_CHARS = 1_000_000

/**
 * Ceiling on read-issue rows one response may carry.
 *
 * The issue list is produced by the read rather than by the spec, so it is the one axis that grows
 * with FAILURE: a rate-limit window part-way through a few-thousand-shard walk logs a row per
 * shard, and an uncapped list makes the report of a degraded read larger than a healthy response.
 * Capping it without saying so would be the same fold every cap here exists to prevent, so it gets
 * a `truncations` row like the rest.
 */
export const PUBLIC_SPEC_MAX_ISSUES = 200

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
export const publicSpecTruncationSectionSchema = v.picklist([
  'requirements',
  'rules',
  'acceptance',
  'features',
  'issues',
])
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
 * How the presence anchor (`spec/service.json`) resolved, for a caller that got a `200`.
 *
 * {@link specAnchorStateSchema} minus `read_failed`, which never reaches a body here: an unread
 * repository is a `503` carrying `reason: "spec_read_failed"`. What remains are the three states
 * that are FACTS ABOUT THE REPOSITORY, and they are served as three values rather than folded into
 * one boolean because they need different reactions:
 *
 *  - `present`  — a spec was read. `spec` is the tree.
 *  - `absent`   — the default branch holds no `spec/service.json`. The common, final answer, and
 *    the only one that means "this service declares nothing".
 *  - `unparsed` — the anchor is THERE and unusable (truncated JSON, a half-written commit). The
 *    tree is unavailable for a reason somebody has to fix in the repository, and an integrator
 *    treating it as "no requirements" would be reporting a broken file as an empty service.
 *
 * A boolean carried the first two and quietly folded the third onto `absent`, discoverable only by
 * noticing an `issues` row. This surface does not fold outcomes; the whole endpoint exists because
 * the internal view does.
 */
export const publicSpecAnchorSchema = v.picklist(['present', 'absent', 'unparsed'])
export type PublicSpecAnchor = v.InferOutput<typeof publicSpecAnchorSchema>

/**
 * The service's specification as `/api/v1` serves it.
 *
 * A `200` here never means the repository could not be read (a `503` with
 * `reason: "spec_read_failed"`), that no repository is linked (a `422`), or that this deployment
 * wired no VCS integration (a `503` with `reason: "vcs_not_configured"`). What it does mean is
 * {@link PublicServiceSpec.anchor}.
 */
export const publicServiceSpecSchema = v.object({
  /** The board service frame this spec belongs to, echoed so a response stands alone. */
  serviceId: v.string(),
  /**
   * What the default branch holds where the spec should be. `spec` is non-null exactly when this
   * is `present`; the other two are the two ways it can be null.
   */
  anchor: publicSpecAnchorSchema,
  /**
   * The structured tree (modules → groups → requirements + rules), or null when `anchor` is not
   * `present`. {@link readSpecDocSchema} rather than the strict authoring schema: a spec whose
   * anchor names no service is a state a repository can genuinely be in, and this surface has to
   * describe repositories as they are.
   */
  spec: v.nullable(readSpecDocSchema),
  /** The rendered Gherkin, one entry per `.feature` file. Empty when the repo renders none. */
  features: v.array(publicSpecFeatureFileSchema),
  provenance: publicSpecProvenanceSchema,
  /**
   * Files the read could not fully account for: a provider error on one shard, a shard whose JSON
   * is unusable, a group salvaged with some requirements dropped, the tail a spent read budget
   * never reached. A present-but-partial spec is served rather than refused, and this is what
   * stops the part that arrived reading as the whole.
   *
   * Capped at {@link PUBLIC_SPEC_MAX_ISSUES}, with a `truncations` row when the cap bit.
   */
  issues: v.array(specReadIssueSchema),
  /** Every cap that bit. Empty when nothing was left out. */
  truncations: v.array(publicSpecTruncationSchema),
})
export type PublicServiceSpec = v.InferOutput<typeof publicServiceSpecSchema>

/**
 * How the presence anchor resolved for a RUN's spec, for a caller that got a `200`.
 *
 * {@link publicSpecAnchorSchema} plus `not_read`, which is a fact about the RUN rather than about
 * the repository and therefore cannot occur on the service-scoped read:
 *
 *  - `not_read` — nothing was read. The run's spec read is gated on a tester having reported, so
 *    that the tree served is the one the verdicts were made against; before that point the
 *    platform has consulted no tree, which is exactly what `requirements.spec: "not_read"` on the
 *    same run's outcome summary already says. `provenance` is null, because there is no snapshot
 *    to name.
 *
 * A separate picklist rather than a fourth member on the service one: `not_read` is unreachable
 * there, and an enum carrying a value its endpoint can never answer is a state consumers write
 * dead branches for.
 */
export const publicRunSpecAnchorSchema = v.picklist(['present', 'absent', 'unparsed', 'not_read'])
export type PublicRunSpecAnchor = v.InferOutput<typeof publicRunSpecAnchorSchema>

/**
 * The spec ONE RUN was judged against, as `/api/v1` serves it.
 *
 * The sibling of {@link publicServiceSpecSchema} rather than a flag on it, for the reason the
 * internal pair already splits on: they answer different questions. The service read answers "what
 * does this service require", from the repository's DEFAULT branch. This answers "what did this run
 * rule on", from the branch the run pushed its work to, which is a different tree for as long as
 * the pull request is open. A caller joining `requirements` rows on `/api/v1/runs/:runId/outcome`
 * or `…/report` back to the criteria they were scored against needs THIS one: every requirement the
 * run itself added is missing from the default branch, so the service read leaves each of those
 * verdicts unjoinable.
 *
 * Same body as the service read (the tree, the Gherkin, the issues, the caps), because it is the
 * same document read at a different ref, and two wire shapes over one artifact are two things to
 * keep in step. What differs is the key (`runId`), the fourth {@link publicRunSpecAnchorSchema}
 * state, and a nullable `provenance`.
 */
export const publicRunSpecSchema = v.object({
  /** The run this spec was read for, echoed so a response stands alone. */
  runId: v.string(),
  /**
   * What the RUN's branch holds where the spec should be, or `not_read` when the platform has
   * consulted no tree for this run yet. `spec` is non-null exactly when this is `present`.
   */
  anchor: publicRunSpecAnchorSchema,
  /** The structured tree, or null when `anchor` is not `present`. */
  spec: v.nullable(readSpecDocSchema),
  /** The rendered Gherkin, one entry per `.feature` file. */
  features: v.array(publicSpecFeatureFileSchema),
  /**
   * Where the tree was read from: the RUN's branch (its pull request's head while one is open, the
   * repository default otherwise) and the commit it was at.
   *
   * Null exactly when `anchor` is `not_read`, and that is the whole reason it is nullable: there is
   * no snapshot to name, and naming the branch anyway would imply a read that did not happen.
   */
  provenance: v.nullable(publicSpecProvenanceSchema),
  /** Files the read could not fully account for. Capped at {@link PUBLIC_SPEC_MAX_ISSUES}. */
  issues: v.array(specReadIssueSchema),
  /** Every cap that bit. Empty when nothing was left out. */
  truncations: v.array(publicSpecTruncationSchema),
})
export type PublicRunSpec = v.InferOutput<typeof publicRunSpecSchema>
