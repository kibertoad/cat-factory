import * as v from 'valibot'
// Purpose vocabulary + predicates own their module; it type-imports `Pipeline` (erased), so
// this value import is not a runtime cycle.
import { pipelinePurposeSchema } from './pipeline-purpose.js'
import { workspaceAccessModeSchema } from './workspace-members.js'
import { subscriptionVendorSchema } from './vendor-credentials.js'
import { agentConfigValuesSchema } from './agent-config.js'
import { consensusStepConfigSchema, stepGatingSchema, taskEstimateSchema } from './consensus.js'
import { cloudProviderSchema, instanceSizeSchema } from './compute-provisioning.js'
import { serviceProvisioningSchema } from './environments.js'
import { documentSourceKindSchema } from './documents.js'
import { frontendConfigSchema } from './frontend.js'
import { serviceConnectionsSchema } from './service-connections.js'
import {
  agentKindSchema,
  blockLevelSchema,
  blockStatusSchema,
  blockTypeSchema,
  positionSchema,
  sizeSchema,
  taskTypeFieldsSchema,
  taskTypeSchema,
} from './primitives.js'

// ---------------------------------------------------------------------------
// Entity schemas: the single source of truth for the data shapes that travel
// over the wire. Domain types in @cat-factory/kernel are derived from these, and
// the worker validates responses against them, so frontend, core and facade can
// never silently drift apart.
// ---------------------------------------------------------------------------

/**
 * A lightweight link from a block to the pull request an implementation agent
 * opened for it. Distinct from the richer {@link GitHubPullRequest} projection
 * (synced from GitHub): this is just enough to display the PR on the board and
 * navigate to it. Recorded on a task when its container ("implementer") agent
 * pushes a branch and opens a PR.
 */
export const pullRequestRefSchema = v.object({
  /** The PR's web URL, opened when the user clicks through from the board. */
  url: v.string(),
  /** The PR number within the repo, shown as `#<number>` when known. */
  number: v.optional(v.number()),
  /** The head branch the agent pushed its work to, when known. */
  branch: v.optional(v.string()),
})
export type PullRequestRef = v.InferOutput<typeof pullRequestRefSchema>

/**
 * A pull request the container "implementer" agent opened in a CONNECTED service's repo
 * during a multi-repo run (the service-connections initiative, phase 3): the coding agent
 * clones every involved service's repo as a sibling checkout and opens one PR per repo it
 * actually changed. The task's OWN-service PR stays on {@link blockSchema.pullRequest}
 * (singular); this array carries the PRs opened in the PEER repos, each attributed to the
 * repo (`owner/name`) and the involved service frame it belongs to.
 */
export const peerPullRequestSchema = v.object({
  /** The peer repo the PR was opened in, `owner/name`. */
  repo: v.string(),
  /** The involved service frame's block id this repo resolved from, when known. */
  frameId: v.optional(v.string()),
  /** The PR link itself, same shape as the own-service {@link pullRequestRefSchema}. */
  ref: pullRequestRefSchema,
})
export type PeerPullRequest = v.InferOutput<typeof peerPullRequestSchema>

/**
 * A repository attached to a document-authoring task purely as READ-ONLY reference: the
 * `doc-writer` agent clones each one as a sibling checkout it may read (to reuse existing
 * solutions as a reference) but NEVER writes to — no branch, no commit, no PR. Unlike an
 * involved service ({@link blockSchema.entries.involvedServiceIds}), a reference repo is
 * not a board service and need not be in the workspace's synced repo projection: it may be
 * ANY repo the workspace's VCS connection (hosted) or the configured PAT (local) can reach,
 * so its clone identity is stored self-contained here rather than resolved from the projection.
 *
 * Provider-neutral by construction: the fields mirror the kernel's VCS identity vocabulary
 * (`VcsRepoRef` / `VcsConnectionRef`), NOT GitHub-specific names — the concrete provider is a
 * deployment-level fact resolved server-side when the clone URL is built (see `ResolveRepoOrigin`
 * in `@cat-factory/server`), so a GitHub or GitLab deployment persists the same shape.
 */
export const referenceRepoSchema = v.object({
  /**
   * The provider's canonical repo identity (GitHub numeric id / GitLab project id). Numeric on
   * every provider this platform surfaces through the available-repos picker (`repoId` in the
   * kernel's `VcsRepoRef` is stringly-typed to also admit path ids; the picker uses the numeric
   * form for both).
   */
  repoId: v.number(),
  /** The repo owner (org/user login, or GitLab group). */
  owner: v.string(),
  /** The repo name (or GitLab project). */
  name: v.string(),
  /** The branch the reference checkout is cloned at (the repo's default branch). */
  defaultBranch: v.string(),
  /**
   * The VCS connection that can access this repo, when known (GitHub App installation / GitLab
   * connection id — the `connectionId` of the kernel's `VcsConnectionRef`). Absent for a repo
   * reachable only via the run initiator's own token (local mode / a `personal`-badged search
   * hit), which is cloned with that token rather than the workspace connection's.
   */
  connectionId: v.optional(v.number()),
})
export type ReferenceRepo = v.InferOutput<typeof referenceRepoSchema>

/**
 * A conservative git-ref-name safety check (a subset of `git check-ref-format --branch`).
 * Rejects the shapes that would break the harness's `git fetch`/checkout of a caller-named
 * branch or let a value smuggle in flags/paths: whitespace, the special chars git forbids
 * in a ref component (`~ ^ : ? * [ \`), a `..` sequence, the `@{` reflog syntax, a bare `@`,
 * a leading/trailing/doubled `/`, a leading `-` (would read as a flag), an ASCII control
 * char, and the `.lock` suffix. Not exhaustive against every git edge case, but enough that a
 * stored value is a plausible branch name and never a shell/flag/path-injection vector.
 */
export function isSafeGitBranchName(name: string): boolean {
  if (name.length === 0) return false
  if (name === '@') return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false
  if (name.endsWith('.lock')) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  const forbidden = '~^:?*[\\'
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    // Control chars (0x00-0x1f), space (0x20), DEL (0x7f), and the chars git forbids in a
    // ref component (~ ^ : ? * [ backslash).
    if (code <= 0x20 || code === 0x7f || forbidden.includes(ch)) return false
  }
  return true
}

const branchNameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(200),
  v.check(isSafeGitBranchName, 'Not a valid git branch name'),
)

/**
 * A pre-existing branch of a task's PRIMARY target repo handed to the run as input. Two
 * deliberately-disjoint modes (see `docs/initiatives/apriori-branches.md`):
 *
 * - `reference` — provided purely as context (a spike / prototype / prior-art branch). The
 *   agent may read it (log/diff/open files) but NEVER commits to or pushes it.
 * - `working` — the branch the run keeps building inside: it starts from and continues
 *   committing into this branch instead of minting `cat-factory/<blockId>` off the default,
 *   and the PR/CI-gate/merger all ride it. At most ONE working entry per task (enforced at
 *   the write boundary in `BoardService.updateBlock`).
 */
export const aprioriBranchSchema = v.object({
  /** The existing branch name on the primary target repo. */
  name: branchNameSchema,
  /** `reference` = read-only context; `working` = the branch the run builds inside. */
  mode: v.picklist(['reference', 'working']),
})
export type AprioriBranch = v.InferOutput<typeof aprioriBranchSchema>

/** The single `working` apriori branch of a task, or undefined when none is set. */
export function aprioriWorkingBranch(branches: AprioriBranch[] | undefined): string | undefined {
  return branches?.find((b) => b.mode === 'working')?.name
}

/**
 * The task's `working` apriori branch resolved against the run's repo base branch: returns the
 * branch name (or undefined when none is set), throwing when it equals the base — a run that
 * builds inside the base would have nothing to diff and no PR to open. This is a RUNTIME check
 * (the base branch is a repo fact unknown at the write boundary), shared by the dispatch sites
 * that swap in the work branch (`ContainerAgentExecutor` + the `RunDispatcher` repo-ops) so
 * their rejection can't drift apart.
 */
export function resolveAprioriWorkingBranch(
  branches: AprioriBranch[] | undefined,
  baseBranch: string,
): string | undefined {
  const working = aprioriWorkingBranch(branches)
  if (working && working === baseBranch) {
    throw new Error(
      `Apriori working branch '${working}' is the repo's base branch; ` +
        `pick an existing feature branch to build inside, not the base.`,
    )
  }
  return working
}

/** The `reference` apriori branch names of a task (possibly empty). */
export function aprioriReferenceBranches(branches: AprioriBranch[] | undefined): string[] {
  return branches?.filter((b) => b.mode === 'reference').map((b) => b.name) ?? []
}

/**
 * Per-task override for an issue-tracker writeback action (see the workspace-level
 * `writebackCommentOnPrOpen` / `writebackResolveOnMerge` in tracker settings).
 * `on`/`off` force the behaviour for this task; absent ⇒ inherit the workspace setting.
 */
export const writebackOverrideSchema = v.picklist(['on', 'off'])
export type WritebackOverride = v.InferOutput<typeof writebackOverrideSchema>

export const blockSchema = v.object({
  id: v.string(),
  title: v.string(),
  type: blockTypeSchema,
  description: v.string(),
  position: positionSchema,
  /**
   * An explicit, user-set pixel size for the block (service frames are resizable
   * by dragging their borders). Absent means the board auto-sizes the frame from
   * its contents; present is the dragged size (the client never shrinks it below
   * the content's natural extent). Only frames carry this today.
   */
  size: v.optional(sizeSchema),
  status: blockStatusSchema,
  progress: v.number(),
  dependsOn: v.array(v.string()),
  executionId: v.nullable(v.string()),
  level: blockLevelSchema,
  parentId: v.nullable(v.string()),
  /**
   * Membership link to an `epic`-level block, INDEPENDENT of `parentId` (which
   * stays the structural container). A task carries its epic id here so an epic
   * can group tasks living under different modules/services; the epic is drawn
   * linked to all such members and its inspector lists them. Absent/null ⇒ not in
   * an epic. Only meaningful on `task`-level blocks.
   */
  epicId: v.optional(v.nullable(v.string())),
  /**
   * Membership link to an `initiative`-level block, INDEPENDENT of `parentId`.
   * A task spawned by an initiative's execution loop carries the initiative's
   * block id here so the loop can reconcile its items from the spawned blocks
   * and the board can badge initiative work. Absent/null ⇒ not spawned by an
   * initiative. Only meaningful on `task`-level blocks.
   */
  initiativeId: v.optional(v.nullable(v.string())),
  /**
   * Preceding-task toggle: when this task's PR merges (it reaches `done`), the
   * engine automatically starts every task that `dependsOn` it and whose other
   * dependencies are also done. Off/absent ⇒ dependents wait for a manual start.
   * Only meaningful on `task`-level blocks.
   */
  autoStartDependents: v.optional(v.boolean()),
  confidence: v.optional(v.number()),
  /**
   * The `task-estimator` agent's triage of this task (complexity / risk / impact,
   * each 0..1, + rationale). Written by a `task-estimator` pipeline step once it
   * runs; surfaced in the UI and used to gate consensus steps. Absent until a
   * task-estimator step has run. Only meaningful on `task`-level blocks.
   */
  estimate: v.optional(v.nullable(taskEstimateSchema)),
  moduleName: v.optional(v.string()),
  /**
   * The kind of work this task represents (feature / bug / document / spike / recurring),
   * chosen by the human at creation. Drives the card's icon/badge, the per-type creation
   * fields, and the per-service running-task limit's optional per-type bucketing. Only
   * meaningful on `task`-level blocks; absent ⇒ treated as `feature`.
   */
  taskType: v.optional(taskTypeSchema),
  /**
   * Small per-type fields collected on the create-task form (see {@link taskTypeFieldsSchema}),
   * e.g. a bug's severity / repro steps, a spike's time-box. Only meaningful on `task`-level
   * blocks; absent ⇒ none collected.
   */
  taskTypeFields: v.optional(v.nullable(taskTypeFieldsSchema)),
  /**
   * Whether this task is purely TECHNICAL (a refactor / non-functional / internal change
   * with no externally-observable behaviour). When `true` the implementer treats the task
   * definition / incorporated requirements as the PRIMARY source of truth and the
   * committed specs as a regression-spotting reference, not the authority; the spec-writer
   * is free to produce no business specs. `false` is the explicit BUSINESS case: the
   * spec-writer is then required to produce specs (it is told not to claim "no business
   * specs"), and the implementer follows the spec as usual. A human may set it explicitly
   * (creation checkbox / inspector toggle); left unset it is inferred from the spec phase
   * (the writer's `noBusinessSpecs` + the spec-companion's corroboration). Only meaningful
   * on `task`-level blocks. `null`/absent ⇒ not yet determined (the engine may infer it).
   * Once a concrete `true`/`false` is recorded it is authoritative and the engine does NOT
   * re-infer over it — whether it was set by a human or a prior inference — for stability;
   * a human can still change it any time via the tri-state inspector toggle (unset /
   * technical / business, where "unset" sends `null` to re-open it to inference).
   */
  technical: v.optional(v.nullable(v.boolean())),
  /**
   * Ids of curated best-practice prompt fragments selected for this block — the block's OWN,
   * authoritative selection. On a TASK this is what the engine folds into its `code-aware` /
   * `doc-aware` steps (the enclosing service's fragments are NOT re-unioned at run time), seeded
   * from the service at creation and then freely add/removable per task. Their bodies are composed
   * into the agent system prompt at run time; the catalog itself lives in
   * @cat-factory/prompt-fragments (+ the tenant library) and is served separately.
   */
  fragmentIds: v.optional(v.array(v.string())),
  /**
   * Service-level (frame-only): ids of the best-practice / guideline prompt fragments selected as
   * this service's programming standards (drawn from the universal pool in
   * @cat-factory/prompt-fragments). They serve two roles: (1) they SEED a new task's own
   * `fragmentIds` at creation (materialised onto the task, which owns its selection from then on —
   * an existing task is NOT retroactively updated when this list later changes; a new fragment is
   * picked up by adding it to the task by hand), and (2) at run time the engine folds them into the
   * frame's OWN `code-aware` runs (e.g. `blueprints`). Seeded from the workspace default on new
   * services; a task does not re-read them at run time.
   */
  serviceFragmentIds: v.optional(v.array(v.string())),
  /**
   * Id of the LLM model selected for this block from the shared model catalog
   * (see MODEL_CATALOG in @cat-factory/kernel). When set it overrides the agent
   * routing's default model at run time; absent means "use the routing default".
   */
  modelId: v.optional(v.string()),
  /**
   * Task-level configuration values contributed by the agents in the task's
   * pipeline (see {@link agentConfigValuesSchema}) — a sparse id→value map. Each
   * value is editable until its contributing agent's step starts, then freezes.
   * Used e.g. for the Tester's `tester.environment` (local vs ephemeral) choice.
   * Only meaningful on `task`-level blocks.
   */
  agentConfig: v.optional(agentConfigValuesSchema),
  /**
   * Service-level (frame-only): the service-owned provisioning config — the provision
   * TYPE this service produces (kubernetes / docker-compose / custom / infraless) plus
   * the in-repo specifics (manifest source, compose path, custom manifest id). The
   * workspace/user config separately describes HOW each type is handled (the engine); the
   * deployer merges the two at run time, and the Tester's start-time infra gate keys off
   * it (`infraless` runs with no infra; any other type needs a workspace handler that
   * resolves). See docs/initiatives/per-service-provision-types.md. Absent ⇒ the Tester
   * runs with no infra stood up.
   */
  provisioning: v.optional(serviceProvisioningSchema),
  /**
   * Service-level (frame-only): the cloud provider this service's container jobs
   * run on. Absent means the owning account's `defaultCloudProvider`.
   */
  cloudProvider: v.optional(cloudProviderSchema),
  /**
   * Service-level (frame-only): the abstract instance size for this service's
   * container jobs, resolved to a provider-specific id at dispatch. Absent means
   * the built-in default size.
   */
  instanceSize: v.optional(instanceSizeSchema),
  /**
   * Frontend-frame-level (`type: 'frontend'`): how to build, serve, and mock this
   * frontend for a self-contained UI test (+ an optional browsable preview on
   * local/node), and its backend bindings — env-var → upstream, which double as the
   * board's frontend→service links. See {@link frontendConfigSchema} and
   * docs/initiatives/frontend-preview-ui-testing.md. Absent on non-frontend frames.
   */
  frontendConfig: v.optional(frontendConfigSchema),
  /**
   * Service-frame-level (`type: 'service'`): this service's directed connections
   * to the other services it uses, stored on the consumer end (see
   * {@link serviceConnectionSchema}). Drawn as board edges, and the source of the
   * per-task "involved services" choices ({@link blockSchema.entries.involvedServiceIds}).
   * Absent on non-service blocks.
   */
  serviceConnections: v.optional(serviceConnectionsSchema),
  /**
   * Task-level: the connected service frames "directly involved" in this task
   * beyond the task's own service (always implicitly involved, never listed here).
   * Each id must be a connection neighbor of the task's service frame. Involved
   * services are spun up as ephemeral environments alongside the task's own
   * service, and the coding agent may change their repos too.
   */
  involvedServiceIds: v.optional(v.array(v.string())),
  /**
   * The pull request the block's implementation ("implementer") agent opened for
   * its work. Set on a task once its container agent pushes a branch and opens a
   * PR; surfaced on the board so the PR can be opened from the selected task.
   */
  pullRequest: v.optional(pullRequestRefSchema),
  /**
   * PRs the implementer opened in CONNECTED services' repos during a multi-repo run
   * (service-connections phase 3), one per involved-service repo it actually changed.
   * The own-service PR stays on {@link pullRequest}; this is engine-written (never
   * client-patchable) beside it, so single-repo readers stay untouched and only the
   * multi-repo-aware paths read {@link allPullRequests}. Absent for a single-repo task.
   */
  peerPullRequests: v.optional(v.array(peerPullRequestSchema)),
  /**
   * Task-level (document-authoring tasks): repositories attached as READ-ONLY reference
   * material for the `doc-writer` agent — it clones each as a sibling checkout it may read
   * to reuse existing solutions, but never writes to (see {@link referenceRepoSchema}).
   * Distinct from {@link involvedServiceIds}: reference repos are not board services, carry
   * their own clone identity, and are structurally unpushable. Absent on non-doc tasks.
   */
  referenceRepos: v.optional(v.array(referenceRepoSchema)),
  /**
   * Task-level: pre-existing branches of the task's PRIMARY target repo handed to the run
   * as input (see {@link aprioriBranchSchema} and `backend/docs/adr/0021-apriori-branches.md`).
   * At most one `working` entry (the branch the run builds inside instead of minting
   * `cat-factory/<blockId>`); any number of `reference` entries (read-only context). The
   * write boundary (`BoardService.updateBlock`) drops this on non-task blocks and enforces
   * the single-working / no-duplicate / not-frozen-after-PR invariants. Absent ⇒ the run
   * starts from the repo default branch as usual.
   */
  aprioriBranches: v.optional(v.array(aprioriBranchSchema)),
  /**
   * Id of the merge threshold preset selected for this task (see
   * {@link riskPolicySchema}). Drives the `merger` step's auto-merge
   * decision and the CI-fixer attempt budget. Absent means "use the workspace's
   * default preset".
   */
  riskPolicyId: v.optional(v.string()),
  /**
   * Id of the model preset selected for this task (see {@link modelPresetSchema}).
   * Drives which model each agent step runs on (the preset's `overrides[kind] ??
   * baseModelId`) unless the block pins a model directly via {@link modelId}. Absent
   * means "use the workspace's default preset". Editable at any time; a change takes
   * effect on the task's NEXT step (steps already dispatched keep their model).
   */
  modelPresetId: v.optional(v.string()),
  /**
   * Id of the pipeline chosen for this task at creation (see {@link pipelineSchema}).
   * The task's "Start"/"Run" controls default to it; absent means the user picks a
   * pipeline at run time (the board falls back to the first defined pipeline).
   */
  pipelineId: v.optional(v.string()),
  /**
   * Internal user id (`usr_*`) of the person who created this block, captured from
   * the authenticated session at creation (tasks today). Drives "notify the task
   * creator" routing for notifications. Absent/null on blocks created before this
   * was recorded, or with auth disabled (local/dev), where there is no user.
   */
  createdBy: v.optional(v.nullable(v.string())),
  /**
   * Internal user id (`usr_*`) of the account member (a `product` role-holder) made
   * responsible for this task. They are notified when requirement review flags findings.
   * Absent/null when no responsible product person is assigned.
   */
  responsibleProductUserId: v.optional(v.nullable(v.string())),
  /**
   * Per-task override for the "comment on the linked tracker issue when a PR opens"
   * writeback action. Absent/null ⇒ inherit the workspace's `writebackCommentOnPrOpen`.
   * Only meaningful on `task`-level blocks that have a linked tracker issue.
   */
  trackerCommentOnPrOpen: v.optional(v.nullable(writebackOverrideSchema)),
  /**
   * Per-task override for the "close the linked tracker issue as resolved when its PR
   * merges" writeback action. Absent/null ⇒ inherit the workspace's `writebackResolveOnMerge`.
   * Only meaningful on `task`-level blocks that have a linked tracker issue.
   */
  trackerResolveOnMerge: v.optional(v.nullable(writebackOverrideSchema)),
  /**
   * Headless marker: when `true` this block was created by the public API (an external
   * "initiative breakdown" run) purely to anchor an execution, and is EXCLUDED from every
   * board projection — the board-listing read and the workspace snapshot filter it out, so
   * it never renders in the UI. The block still exists for the engine (it carries the run's
   * `executionId` and receives status writes). Absent / false ⇒ a normal, board-visible block.
   */
  internal: v.optional(v.boolean()),
  /**
   * Archive marker for a service frame: when `true` the service (its frame + whole subtree)
   * is hidden from the board projection but fully preserved — it can be restored at any time
   * with NO expiry. Archiving is the alternative to deleting a service that still has
   * unfinished tasks (deletion is rejected for those; archive, then restore later). The
   * snapshot filters an archived frame and its descendants out of `blocks`/`executions` and
   * surfaces it under `archivedServices` instead. Only meaningful on top-level service frames
   * (`level:'frame'`, `parentId:null`). Absent / false ⇒ a normal, board-visible block.
   */
  archived: v.optional(v.boolean()),
  /**
   * Redaction marker set ONLY in the per-viewer workspace snapshot (never persisted): when
   * `true`, this service frame is backed by a repo the requesting user cannot reach (a repo
   * linked via ANOTHER member's personal access token, `GitHubRepo.linkedVia === 'user_pat'`,
   * that this viewer's PAT can't access). The server scrubs the frame's title/description and
   * drops its whole subtree from the snapshot, leaving only the block id + this flag, so the
   * SPA renders a "Permission denied" placeholder instead of the service's contents. Absent ⇒
   * a normal, fully-visible block.
   */
  accessDenied: v.optional(v.boolean()),
})
export type Block = v.InferOutput<typeof blockSchema>

/**
 * Every pull request a block's implementation opened, own-service first then any peer
 * repos (service-connections phase 3). The single source of truth for callers that must
 * act across ALL of a multi-repo task's PRs (phase-4 CI aggregation / merge-all); every
 * single-repo reader keeps reading {@link Block.pullRequest} directly. The own-service
 * entry carries no `repo`/`frameId` (its repo is the task's own service); peers carry both.
 */
export function allPullRequests(
  block: Pick<Block, 'pullRequest' | 'peerPullRequests'>,
): { repo?: string; frameId?: string; ref: PullRequestRef }[] {
  const out: { repo?: string; frameId?: string; ref: PullRequestRef }[] = []
  if (block.pullRequest) out.push({ ref: block.pullRequest })
  for (const peer of block.peerPullRequests ?? []) {
    out.push({ repo: peer.repo, ...(peer.frameId ? { frameId: peer.frameId } : {}), ref: peer.ref })
  }
  return out
}

/**
 * A curated best-practice "prompt fragment" (e.g. Node performance, React state
 * management). The catalog is authored in @cat-factory/prompt-fragments and
 * surfaced to the frontend read-only so a user can pick which apply to a block.
 */
export const promptFragmentSchema = v.object({
  /** Stable id, e.g. `node.performance`. Selection persists this. */
  id: v.string(),
  /** Semver of the body content, for display and future version pinning. */
  version: v.string(),
  /** Human title shown in the picker, e.g. `Node.js performance`. */
  title: v.string(),
  /** Grouping label for the picker, e.g. `Node`, `React`. */
  category: v.string(),
  /** One-line description shown in the picker. */
  summary: v.string(),
  /** The guidance injected into the agent system prompt. */
  body: v.string(),
  /** Optional hints for filtering which blocks/agents a fragment suits. */
  appliesTo: v.optional(
    v.object({
      blockTypes: v.optional(v.array(blockTypeSchema)),
      agentKinds: v.optional(v.array(agentKindSchema)),
    }),
  ),
  /**
   * Free-form tags used by the relevance selector to decide whether a fragment
   * is pertinent to a given run (e.g. `backend`, `frontend`, `db`). Optional and
   * absent on the built-in catalog tier; managed fragments may set them.
   */
  tags: v.optional(v.array(v.string())),
  /**
   * Provenance for a fragment sourced from a repo: which {@link FragmentSource}
   * it came from, the file path within that source, and the blob sha last synced
   * (so a "changed?" check is a cheap comparison). Absent for hand-authored
   * fragments and the built-in catalog.
   */
  source: v.optional(
    v.object({
      sourceId: v.string(),
      path: v.string(),
      sha: v.string(),
    }),
  ),
  /**
   * Provenance for a fragment whose body is a **living** external document
   * (a Confluence/Notion page or a GitHub file). Unlike a repo `source`, a
   * document-backed fragment is NOT a one-time snapshot: at run time the engine
   * re-resolves the page's current content from the linked source (TTL-gated,
   * falling back to the last-resolved `body`). Absent for hand-authored, repo-
   * sourced, and built-in fragments.
   */
  documentRef: v.optional(
    v.object({
      source: documentSourceKindSchema,
      /** The source's stable id for the page/file (a valid import ref). */
      externalId: v.string(),
    }),
  ),
  /** When the document-backed body was last resolved from the source (epoch ms). */
  resolvedAt: v.optional(v.number()),
})
export type PromptFragment = v.InferOutput<typeof promptFragmentSchema>

/** The full catalog as served by `GET /prompt-fragments`. */
export const promptFragmentCatalogSchema = v.array(promptFragmentSchema)
export type PromptFragmentCatalog = v.InferOutput<typeof promptFragmentCatalogSchema>

/** Informational list price for a model, surfaced in the picker. */
export const modelCostSchema = v.object({
  /** List price per 1M input tokens. */
  inputPerMillion: v.number(),
  /** List price per 1M output tokens. */
  outputPerMillion: v.number(),
  /** ISO 4217 currency the prices are expressed in (e.g. `EUR`). */
  currency: v.string(),
})
export type ModelCost = v.InferOutput<typeof modelCostSchema>

/**
 * A selectable LLM model, resolved to the flavour actually in use for this
 * deployment (`GET /models`). `flavor` is `direct` when the model's own provider
 * API key is configured, `openrouter` when it routes through the OpenRouter
 * gateway, `cloudflare` for the Workers AI fallback, or `subscription` for a
 * Claude Code / Codex model run via a stored subscription token. `provider`/`model`
 * are the effective {@link ModelRef} parts the agent will run with; the picker
 * stores only `id`.
 */
export const modelOptionSchema = v.object({
  /** Stable id persisted on a block (`Block.modelId`). */
  id: v.string(),
  /** Model-family label, e.g. `Qwen3`. */
  label: v.string(),
  /** One-line description shown in the picker. */
  description: v.string(),
  /** Which flavour is active for this deployment. */
  flavor: v.picklist(['cloudflare', 'direct', 'openrouter', 'subscription']),
  /**
   * Whether this model is actually selectable given what the workspace has
   * configured: a direct key for its provider, a subscription token for its vendor,
   * or the opt-in Cloudflare lib enabled. The picker disables an unavailable model.
   */
  available: v.optional(v.boolean()),
  /**
   * Whether this model is UNAVAILABLE specifically because the account's model-family
   * policy blocks it (its family is not permitted on the effective route), as distinct
   * from being unconfigured. When true, `available` is also false, but the picker shows
   * a "blocked by account policy" reason instead of the "add a key" hint.
   */
  policyBlocked: v.optional(v.boolean()),
  /** Short provider label for the active flavour, e.g. `Cloudflare`, `DashScope`. */
  providerLabel: v.string(),
  /** Effective provider id the agent runs with. */
  provider: v.string(),
  /** Effective model id within the provider. */
  model: v.string(),
  /**
   * Whether the active flavour's provider caches the re-sent prompt prefix. False on
   * a Cloudflare/Workers-AI flavour (no caching), true once a direct key upgrades the
   * model to its caching `direct` flavour. The pickers surface this so a user can see
   * the hot path running cache-less and act on it (connect a direct key / pick a
   * caching model). Absent ⇒ unknown (older catalog).
   */
  cachesPrompts: v.optional(v.boolean()),
  /**
   * For a `subscription` model, the vendor whose pooled token authenticates it;
   * the frontend enables the option only when the workspace has a token for it.
   */
  vendor: v.optional(subscriptionVendorSchema),
  /** Informational list price for the model, when known. */
  cost: v.optional(modelCostSchema),
  /** The model's context window at the effective provider, when known. */
  contextTokens: v.optional(v.number()),
  /**
   * True when the effective flavour runs on a flat-rate subscription. Its `cost`
   * is illustrative of quota burn rate only — quota-based usage does NOT draw on
   * the monetary spend budget.
   */
  quotaBased: v.optional(v.boolean()),
  /**
   * An alternative subscription flavour for a model that ALSO has a Cloudflare /
   * direct base (e.g. GLM-5.2, Kimi). The frontend renders ONLY this flavour when
   * the workspace has a token for `vendor` (hiding the base), and the executor
   * always prefers it at dispatch. Absent for subscription-only models (whose base
   * IS the subscription) and for models with no subscription path.
   */
  subscription: v.optional(
    v.object({
      vendor: subscriptionVendorSchema,
      providerLabel: v.string(),
      provider: v.string(),
      model: v.string(),
      cachesPrompts: v.optional(v.boolean()),
      cost: v.optional(modelCostSchema),
      contextTokens: v.optional(v.number()),
    }),
  ),
})
export type ModelOption = v.InferOutput<typeof modelOptionSchema>

/** The full catalog as served by `GET /models`. */
export const modelCatalogSchema = v.array(modelOptionSchema)
export type ModelCatalog = v.InferOutput<typeof modelCatalogSchema>

/**
 * The test quality-control companion configuration for a Tester step, as authored in the
 * pipeline builder (parallel to {@link agentKindSchema}). `enabled` toggles the companion;
 * optional `gating` makes it conditional on the task estimate (only QC-gate heavy tasks).
 * A `null`/absent entry on a Tester step means "enabled with no gating" — the companion is
 * on by default.
 */
export const testerQualityConfigSchema = v.object({
  enabled: v.boolean(),
  /** Optional estimate gating: run the QC companion only when the task estimate qualifies. */
  gating: v.optional(v.nullable(stepGatingSchema)),
})
export type TesterQualityConfig = v.InferOutput<typeof testerQualityConfigSchema>

/**
 * The extensible per-step options bag for the pipeline builder. Where the older per-step
 * knobs each got their own index-aligned array (`gates`, `thresholds`, `enabled`,
 * `consensus`, `gating`, `followUps`, `testerQuality`), EVERY NEW per-step parameter is a
 * field on THIS object instead — persisted in one `step_options` JSON column parallel to
 * {@link pipelineSchema.entries.agentKinds}, so a new knob needs no schema column or
 * migration. A `null`/absent entry (or an empty object) means "all defaults" for that step.
 * The legacy parallel arrays are being folded into this seam incrementally — see
 * `docs/initiatives/pipeline-step-options.md`.
 */
export const stepOptionsSchema = v.object({
  /**
   * `requirements-review` only. When enabled (the default), the reviewer classifies each
   * finding, and the ones it judges answerable from universal best-practice / the context
   * already provided get a recommended answer AUTO-generated and offered as the finding's
   * default answer (the human can override or dismiss it); findings that need a genuine
   * business/product decision are left for the human. `false` disables the automation — the
   * human answers (or manually requests recommendations for) every finding. Absent / `true`
   * ⇒ enabled. Ignored on non-`requirements-review` steps.
   */
  autoRecommend: v.optional(v.boolean()),
  /**
   * `skill` steps only. The id of the account-tier repo-sourced Claude Skill this step
   * executes (`src:<sourceId>:<dirName>`; see `docs/initiatives/repo-skills.md`). The one
   * generic `skill` agent kind is parametrized by THIS field — the picked skill's
   * instructions + resources are resolved at dispatch and folded into the step (natively for
   * the claude-code harness, as prompt + `.cat-context/skill/*` for Pi/codex). A `skill` step
   * with no `skillId` has nothing to run and is rejected at pipeline save. Ignored on every
   * other kind.
   */
  skillId: v.optional(v.string()),
})
export type StepOptions = v.InferOutput<typeof stepOptionsSchema>

export const pipelineSchema = v.object({
  id: v.string(),
  name: v.string(),
  /**
   * Optional prose description of what the pipeline is for — a one/two-sentence summary shown
   * alongside its step list in the pipeline pickers (add-task modal, inspector run settings) and
   * the builder. Authored per built-in in `seedPipelines()` and editable on custom pipelines.
   * Absent ⇒ no description (the pickers fall back to the step list alone).
   */
  description: v.optional(v.string()),
  agentKinds: v.array(agentKindSchema),
  /**
   * Per-step human approval gates, parallel to {@link agentKinds}: when
   * `gates[i]` is true the run pauses after step `i` completes so a human can
   * review (and edit) its proposal before the next step runs. Absent / shorter
   * than `agentKinds` means "no gate" for the missing indices, so legacy
   * pipelines run straight through unchanged.
   */
  gates: v.optional(v.array(v.boolean())),
  /**
   * Per-step companion quality thresholds, parallel to {@link agentKinds}: when step
   * `i` is a companion kind, `thresholds[i]` is the minimum rating (0..1) its review
   * must reach for the run to proceed; below it the preceding producer is re-run, and
   * once the rework budget is spent the step parks for a human (the iteration-cap gate).
   * `null`/absent on a companion step means "use the companion's default threshold";
   * ignored on non-companion steps.
   */
  thresholds: v.optional(v.array(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))))),
  /**
   * Per-step enable flags, parallel to {@link agentKinds}: when `enabled[i]` is
   * explicitly `false` the step is kept in the pipeline (so it can be toggled back
   * on) but SKIPPED at run start — the execution instance is built only from the
   * enabled steps. Absent / shorter than `agentKinds`, or `true`, means the step
   * runs, so legacy pipelines run every step unchanged.
   */
  enabled: v.optional(v.array(v.boolean())),
  /**
   * Per-step consensus configuration, parallel to {@link agentKinds}: when
   * `consensus[i]` is set and its `enabled` is true AND step `i`'s kind carries a
   * consensus capability trait, the step runs through the multi-model consensus
   * mechanism (specialist panel / debate / ranked voting) instead of a single LLM
   * call — optionally gated on the task estimate (sub-threshold ⇒ standard agent).
   * `null`/absent means "standard single-actor agent" (the default). Copied onto
   * the run's step at start, like {@link gates}. See {@link consensusStepConfigSchema}.
   */
  consensus: v.optional(v.array(v.nullable(consensusStepConfigSchema))),
  /**
   * Per-step gating, parallel to {@link agentKinds}: when `gating[i]` is set and its
   * `enabled` is true, step `i` runs only if the task estimate meets the threshold
   * (OR across the supplied axes); otherwise it is transparently SKIPPED at runtime.
   * `null`/absent means "always run" (the default). Copied onto the run's step at
   * start, like {@link gates}. A pipeline with any enabled gating requires a
   * `task-estimator` step earlier in the chain. See {@link stepGatingSchema}.
   */
  gating: v.optional(v.array(v.nullable(stepGatingSchema))),
  /**
   * Per-step Follow-up companion toggle, parallel to {@link agentKinds}: governs whether a
   * `coder` step runs the future-looking Follow-up companion (the Coder surfaces loose ends /
   * side-tasks / questions, and the run parks at the step's completion until every item is
   * decided). `followUps[i] === false` disables it on that step; `null`/`true`/absent means
   * "enabled" — so a Coder step gets the companion by default. Ignored on non-`coder` steps.
   * Copied onto the run's step (`followUps.enabled`) at start, like {@link gates}.
   */
  followUps: v.optional(v.array(v.nullable(v.boolean()))),
  /**
   * Per-step test quality-control companion config, parallel to {@link agentKinds}: governs
   * whether a `tester-api`/`tester-ui` step runs the QC companion that reads each Tester
   * report and, when it is incomplete, loops the Tester for a more thorough pass BEFORE the
   * greenlight/fixer decision. `null`/absent on a Tester step means "enabled, no gating" — so
   * a Tester step gets the companion by default; an entry with `enabled: false` disables it,
   * and an entry with `gating` makes it conditional on the task estimate. Ignored on
   * non-Tester steps. Copied onto the run's step (`testerQuality`) at start, like {@link gating}.
   * See {@link testerQualityConfigSchema}.
   */
  testerQuality: v.optional(v.array(v.nullable(testerQualityConfigSchema))),
  /**
   * Per-step options bag, parallel to {@link agentKinds}: the extensible home for NEW
   * per-step parameters (see {@link stepOptionsSchema}), so a new knob no longer needs its
   * own array/column. `null`/absent per entry ⇒ that step's defaults. Copied onto the run's
   * step (`stepOptions`) at start, like {@link gates}. Today it carries only
   * `autoRecommend` (the requirements-review auto-recommendation toggle).
   */
  stepOptions: v.optional(v.array(v.nullable(stepOptionsSchema))),
  /**
   * Free-form organizational labels for the saved-pipeline library (filter/search).
   * Absent ⇒ no labels. Applies to built-in and custom pipelines alike.
   */
  labels: v.optional(v.array(v.string())),
  /**
   * When true the pipeline is archived: kept but hidden from the default library view
   * (a "show archived" toggle reveals it). Organizational only — an archived built-in
   * is still read-only for structure. Absent / false ⇒ active.
   */
  archived: v.optional(v.boolean()),
  /**
   * True for the curated built-in catalog pipelines (`seedPipelines()`). Built-ins
   * are read-only templates: they can be cloned (into an editable copy) but not
   * edited in place. Absent / false on user-created and cloned pipelines.
   */
  builtin: v.optional(v.boolean()),
  /**
   * Monotonic seed version for a built-in pipeline (`seedPipelines()` assigns it). When the
   * current catalog version for this id exceeds the persisted copy's `version`, the app offers
   * to reseed the pipeline from the backend. Absent on user-created/cloned pipelines (they are
   * not version-tracked) and on rows persisted before versioning existed (treated as 0).
   */
  version: v.optional(v.number()),
  /**
   * When true this pipeline may be invoked by an EXTERNAL caller through the public API
   * (`POST /api/v1/initiatives`). Only honored for inline (no-container/no-GitHub) pipelines,
   * so an external initiative run never pushes to a repo. Absent / false ⇒ not exposed to the
   * public API (still fully usable from the authenticated SPA). See the `initiative-breakdown`
   * pipeline for the first public entry.
   */
  public: v.optional(v.boolean()),
  /**
   * How this pipeline may be LAUNCHED: `'one-off'` (only as a manual task), `'recurring'`
   * (only attached to a schedule), or `'both'`. Absent means `'both'` — pre-1.0, no
   * migration/back-fill, so existing rows read as unrestricted. Enforced server-side in
   * {@link ExecutionService.start} (via the run `origin`) and in `RecurringPipelineService`,
   * and used by the SPA pickers to filter the offered pipelines. A `bug-intake` step is
   * meaningless without a schedule, so a pipeline carrying one must be `'recurring'`.
   */
  availability: v.optional(
    v.union([v.literal('one-off'), v.literal('recurring'), v.literal('both')]),
  ),
  // The use-case classifier ({@link PIPELINE_PURPOSES}) the task pickers + builder palette filter
  // on. Absent ⇒ unclassified (pre-1.0, no back-fill): unrestricted, but hidden from a document task.
  purpose: v.optional(pipelinePurposeSchema),
})
export type Pipeline = v.InferOutput<typeof pipelineSchema>
export type PipelineAvailability = NonNullable<Pipeline['availability']>

export const workspaceSchema = v.object({
  id: v.string(),
  name: v.string(),
  /** Optional free-text description (null when unset). */
  description: v.nullable(v.string()),
  createdAt: v.number(),
  /** The account this board belongs to, or null for a legacy/unscoped board. */
  accountId: v.nullable(v.string()),
  /**
   * Workspace-level access mode (RBAC). `account` (the default) keeps the legacy
   * behaviour — every account member sees the board; `restricted` limits it to the
   * explicit member roster. Optional on the wire: absent ⇒ `account`.
   */
  accessMode: v.optional(workspaceAccessModeSchema),
})
export type Workspace = v.InferOutput<typeof workspaceSchema>

/**
 * The spend safeguard's view of the current billing period for one budget tier.
 * Token usage is tracked per LLM call and priced into a single currency; once
 * `costSpent` reaches `costLimit` the engine pauses runs and the frontend shows a
 * warning. The same shape describes each tier — workspace, account, and user — with
 * the tier's own spent/limit. Attached to every snapshot by the facade so the client
 * can render the warning anywhere.
 */
export const spendStatusSchema = v.object({
  /** Start of the current billing period (epoch ms; calendar month, UTC). */
  periodStart: v.number(),
  /** Input (prompt) tokens consumed this period. */
  inputTokens: v.number(),
  /** Output (completion) tokens produced this period. */
  outputTokens: v.number(),
  /** Estimated cost of this period's usage, in `currency`. */
  costSpent: v.number(),
  /** Configured budget for one period, in `currency`. */
  costLimit: v.number(),
  /** ISO 4217 currency the costs are expressed in (e.g. `EUR`). */
  currency: v.string(),
  /** True once `costSpent >= costLimit`: runs are paused until the period rolls over. */
  exceeded: v.boolean(),
})
export type SpendStatus = v.InferOutput<typeof spendStatusSchema>

/**
 * Operator-configured hard ceilings on the account- and user-tier monthly budgets,
 * from the deployment env vars `BUDGET_MAX_MONTHLY_PER_ACCOUNT` /
 * `BUDGET_MAX_MONTHLY_PER_USER`. Null ⇒ that tier has no operator ceiling. Surfaced
 * to the SPA so the budget configuration screens can show the hard limit and prevent
 * a user from configuring a value above it. Values are in the base pricing currency.
 */
export const budgetCapsSchema = v.object({
  /** Max monthly budget any account may configure. Null ⇒ no operator ceiling. */
  accountMonthlyLimitMax: v.nullable(v.number()),
  /** Max monthly budget any user may configure. Null ⇒ no operator ceiling. */
  userMonthlyLimitMax: v.nullable(v.number()),
  /** ISO 4217 currency the caps are expressed in (the base pricing currency). */
  currency: v.string(),
})
export type BudgetCaps = v.InferOutput<typeof budgetCapsSchema>

/**
 * One row of the usage report (the "Usage" settings tab): aggregated token usage for a
 * `(billing, vendor, provider, model)` group over the current billing period. Covers BOTH
 * metered API/proxy calls and flat-rate subscription harness usage. `costEstimate` is real
 * for metered rows and illustrative for subscription rows (what the same tokens would have
 * cost on the metered API — never a billed amount).
 */
export const usageBreakdownRowSchema = v.object({
  /** `'metered'` (real per-token cost, in the spend budget) or `'subscription'` (flat-rate quota). */
  billing: v.picklist(['metered', 'subscription']),
  /** The subscription vendor (claude/codex/glm/kimi/deepseek) for a subscription row; null for metered. */
  vendor: v.nullable(v.string()),
  provider: v.string(),
  model: v.string(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  /** Estimated cost in `UsageReport.currency`; illustrative for subscription rows. */
  costEstimate: v.number(),
  /** Number of recorded calls in this group. */
  calls: v.number(),
})
export type UsageBreakdownRow = v.InferOutput<typeof usageBreakdownRowSchema>

/**
 * The workspace usage report for the current billing period: per-`(billing, vendor,
 * provider, model)` rows plus the period start + currency the costs are expressed in. Both
 * metered and subscription usage; the spend budget still counts only the metered rows.
 */
export const usageReportSchema = v.object({
  /** Start of the current billing period (epoch ms; calendar month, UTC). */
  periodStart: v.number(),
  /** ISO 4217 currency `costEstimate` is expressed in. */
  currency: v.string(),
  rows: v.array(usageBreakdownRowSchema),
})
export type UsageReport = v.InferOutput<typeof usageReportSchema>

// The workspace snapshot schema lives in ./snapshot — it references
// `bootstrapJobSchema` from ./bootstrap, which itself imports from this file, so
// keeping it here would be a circular import.
