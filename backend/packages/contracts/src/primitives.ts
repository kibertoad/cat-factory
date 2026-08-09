import * as v from 'valibot'
import { descriptorFieldValuesSchema } from './form-fields.js'

// Shared scalar schemas. Picklists mirror the frontend's `app/types/domain.ts`
// unions exactly, so a payload that validates here drops straight into the Pinia
// stores without translation.

/** A non-empty string (trimming is left to each caller that needs it). */
export const nonEmpty = v.pipe(v.string(), v.minLength(1))

/** A bounded, trimmed URL string (≤2000 chars). Not a full URL parse — the runtime validates reachability. */
export const urlString = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000))

/**
 * A CONSUMER-namespaced id: `<ns>:<name>`, each segment a lowercase `a-z0-9` dash-separated
 * token (e.g. `acme:security-report`, `acme:incident`). The colon distinguishes a
 * deployment-provided id from a bare built-in one, so a namespaced consumer id is accepted
 * across EVERY extension surface (result views, task types, form panels, …) while a typo'd
 * built-in (no colon, not in that surface's picklist) is still rejected — the typo guardrail.
 * This is the SINGLE source of truth for the rule; every extension schema
 * (`agentPresentationSchema.resultView`, `taskTypeSchema`, `customTaskTypeSchema.formPanel`,
 * …) shares these atoms so they can't drift. (Generalized from the original result-view-only
 * `NAMESPACED_RESULT_VIEW_ID_PATTERN`.)
 */
export const NAMESPACED_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whether `id` is a well-formed consumer-namespaced id (`<ns>:<name>`). */
export function isNamespacedId(id: string): boolean {
  return NAMESPACED_ID_PATTERN.test(id)
}

/**
 * A valibot schema accepting exactly a well-formed consumer-namespaced id. Unioned with a
 * built-in picklist wherever an extension surface widens a closed set to also admit
 * deployment-provided ids (the union keeps the picklist's literal-type narrowing that a bare
 * predicate would erase — see `agentPresentationSchema.resultView` / `taskTypeSchema`).
 */
export const namespacedIdSchema = v.pipe(
  v.string(),
  v.regex(
    NAMESPACED_ID_PATTERN,
    'Consumer id must be <namespace>:<name> (lowercase a-z0-9, dash-separated)',
  ),
)

export const blockTypeSchema = v.picklist([
  'frontend',
  'service',
  'library',
  'document',
  'api',
  'database',
  'queue',
  'integration',
  'external',
  'environment',
])
export type BlockType = v.InferOutput<typeof blockTypeSchema>

/**
 * The repository roles a human can pick when importing an existing repo or bootstrapping a
 * new one. Unlike the full {@link blockTypeSchema} (which also carries cosmetic-only labels
 * like `api`/`database`), these four are BEHAVIOURAL frame kinds:
 *   - `service`  — a backend service (full pipelines, ephemeral env, testers).
 *   - `frontend` — a frontend app (backend links + the self-contained UI-test flow).
 *   - `library`  — a published package (build/test/merge, no deploy/env, no tester infra).
 *   - `document` — a document repository (only `spike`/`document` tasks + doc pipelines).
 * The onboarding UIs offer exactly this set; `service` is the default.
 */
export const frameRepoTypeSchema = v.picklist(['service', 'frontend', 'library', 'document'])
export type FrameRepoType = v.InferOutput<typeof frameRepoTypeSchema>

/** The behavioural repo roles, in display order. Shared by the import + bootstrap selectors. */
export const FRAME_REPO_TYPES = ['service', 'frontend', 'library', 'document'] as const

export const blockStatusSchema = v.picklist([
  'planned',
  'ready',
  'in_progress',
  'blocked',
  'pr_ready',
  'done',
])
export type BlockStatus = v.InferOutput<typeof blockStatusSchema>

/**
 * A block's place in the board hierarchy. `frame`/`module`/`task` form the
 * structural containment tree (`parentId`); `epic` is a NON-structural grouping
 * node — it groups tasks (which may live under different modules/services) via
 * their `epicId` membership link, not via `parentId`, so deleting an epic never
 * deletes its member tasks. `initiative` is a structural child of a frame (like
 * a module) anchoring a long-running multi-task body of work: its plan lives in
 * the `initiatives` entity, and the tasks its execution loop spawns link back
 * via their `initiativeId` membership link (epic-style, not containment).
 */
export const blockLevelSchema = v.picklist(['frame', 'module', 'task', 'epic', 'initiative'])
export type BlockLevel = v.InferOutput<typeof blockLevelSchema>

/**
 * Which levels a PIPELINE RUN can be started on, and therefore which blocks' `riskPolicyId`
 * resolves into a merge policy.
 *
 * A total `Record` over the picklist rather than a `level === 'task'` test at each reader: the
 * answer is consulted by the preset-selection guard, which refuses a board write that would put a
 * block under a policy the editor's own role may not have, and a reader that quietly assumed
 * "tasks only" is a hole rather than a wrong answer. `initiative` is the case that already proved
 * it: an initiative block starts its own planning chain (`assertInitiativeShapeAllowed`), so its
 * pinned preset governs real runs, and a task-only filter saw nothing to judge.
 *
 * `frame` / `module` / `epic` are structure, not work: nothing starts a run on one, so no preset
 * of theirs is ever resolved. Adding a level fails this typecheck until it is classified, which is
 * the point.
 */
export const BLOCK_LEVEL_RUNS_PIPELINES: Record<BlockLevel, boolean> = {
  frame: false,
  module: false,
  task: true,
  epic: false,
  initiative: true,
}

/** The BUILT-IN task types, in display order (the closed set before any deployment widening). */
export const BUILTIN_TASK_TYPES = [
  'feature',
  'bug',
  'document',
  'spike',
  'review',
  'ralph',
  'recurring',
] as const
/** The built-in task types a human can pick in the create-task form (`recurring` is schedule-only). */
export const BUILTIN_CREATE_TASK_TYPES = [
  'feature',
  'bug',
  'document',
  'spike',
  'review',
  'ralph',
] as const

/**
 * The kind of work a task represents, chosen by the human at creation. Drives the
 * task card's icon/badge, per-type creation fields, and (optionally) the per-service
 * running-task limit's bucketing. `review` is a deep-review of an EXISTING open pull
 * request (see {@link taskTypeFieldsSchema}'s `prNumber`/`prUrl`); `recurring` is
 * special: such tasks are NOT created through `addTask` — they are the reused on-board
 * block of a recurring-pipeline schedule, stamped with this type so the board renders
 * them consistently.
 *
 * A BUILT-IN id OR a CONSUMER-namespaced one ({@link namespacedIdSchema}, `<ns>:<name>`,
 * e.g. `acme:incident`) a deployment registers via its app-owned `TaskTypeRegistry` — the
 * exact `picklist ∪ namespaced` shape `agentPresentationSchema.resultView` uses. A bare
 * non-built-in id still fails validation (the typo guardrail); a namespaced id is trusted to
 * the deployment and rendered from its registered presentation (an unregistered one degrades
 * to the `feature` presentation on the frontend, so stale data never breaks a card).
 */
export const taskTypeSchema = v.union([v.picklist(BUILTIN_TASK_TYPES), namespacedIdSchema])
export type TaskType = v.InferOutput<typeof taskTypeSchema>

/** The task types a human can pick in the create-task form (recurring is created via a schedule). */
export const createTaskTypeSchema = v.union([
  v.picklist(BUILTIN_CREATE_TASK_TYPES),
  namespacedIdSchema,
])
export type CreateTaskType = v.InferOutput<typeof createTaskTypeSchema>

/**
 * The kinds of document a `document` task can produce. Drives the document-authoring
 * pipeline's prompts (each kind implies a structure: a PRD vs an RFC vs a runbook) and
 * the default in-repo location the writer commits to. An open-ended `reference`/`other`
 * keeps the list from constraining genuine one-offs.
 */
export const DOC_KINDS = [
  'prd',
  'rfc',
  'adr',
  'design',
  'technical',
  'api',
  'runbook',
  'research',
  'reference',
  'other',
] as const
export type DocKind = (typeof DOC_KINDS)[number]

/**
 * Whether a `document` task's `targetPath` is a SAFE relative Markdown path. The value is used
 * verbatim as the in-repo file the doc-writer commits, so it must not escape the repo or
 * clobber non-document files: no `..` traversal, no absolute path (`/…` or a Windows drive),
 * no backslash / NUL, and it must end in `.md`. Rejecting e.g. `../../package.json` at the
 * write boundary stops a malformed (or hostile) path from overwriting arbitrary repo files.
 */
export function isSafeDocPath(path: string): boolean {
  const p = path.trim()
  if (!p || p.length > 300) return false
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false
  if (p.includes('\\') || p.includes('\0')) return false
  if (p.split('/').some((segment) => segment === '..')) return false
  return p.toLowerCase().endsWith('.md')
}

/**
 * Small, additive, per-type fields collected on the create-task form. All optional;
 * which ones are shown depends on the chosen {@link TaskType}. Stored verbatim on the
 * block as a sparse object so adding a field never needs a schema migration.
 */
export const taskTypeFieldsSchema = v.object({
  /** Bug: how severe the defect is. */
  severity: v.optional(v.picklist(['low', 'medium', 'high', 'critical'])),
  /** Bug: reproduction steps / observed-vs-expected. */
  stepsToReproduce: v.optional(v.pipe(v.string(), v.maxLength(4000))),
  /** Spike: the investigation time-box, in hours. */
  timeboxHours: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1000))),
  /** Spike: the success/acceptance criteria or the decision the investigation must inform. */
  successCriteria: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** Document: what kind of document this task produces. */
  docKind: v.optional(v.picklist(DOC_KINDS)),
  /** Document: the intended audience (e.g. "platform engineers", "product stakeholders"). */
  audience: v.optional(v.pipe(v.string(), v.maxLength(300))),
  /**
   * Document: an explicit in-repo path the document is written to, overriding the
   * pipeline's default `docs/<kind>/<slug>.md` location (e.g. `docs/rfcs/0001-foo.md`).
   * Constrained to a safe relative Markdown path (see {@link isSafeDocPath}) so it can't
   * escape the repo or overwrite non-document files.
   */
  targetPath: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(300),
      v.check(
        isSafeDocPath,
        'targetPath must be a relative path inside the repo, ending in .md, with no "..", absolute, or backslash segments.',
      ),
    ),
  ),
  /** Document: freeform hints on the sections / structure the author should produce. */
  outlineHints: v.optional(v.pipe(v.string(), v.maxLength(4000))),

  // --- Per-`DocKind` specific fields (see DOC_KIND_FIELDS) -------------------
  // Shown on the create-task form only for the relevant kind and folded into the author
  // agents' brief as required content for that kind's matching section. All optional and
  // sparse, so a new field never needs a migration (the whole point of this bag).
  //
  /** PRD: who the product is for and the jobs they are trying to do. */
  targetUsers: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** PRD: the measurable outcomes that indicate the product is working. */
  successMetrics: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** RFC: the alternative approaches weighed and why they were ruled out. */
  alternativesConsidered: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** RFC: migration / rollout concerns to address. */
  rolloutConcerns: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** ADR: the forces and constraints driving the decision. */
  decisionDrivers: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** ADR: the options evaluated, each with its trade-offs. */
  consideredOptions: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** Runbook: the trigger or situation this runbook applies to. */
  whenToUse: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** Runbook: who to contact and how to escalate when the procedure fails. */
  escalationPath: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** Research / spike: the question or hypothesis the investigation sets out to answer. */
  researchQuestion: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** Research / spike: the options to weigh against each other. */
  optionsToCompare: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** API: the endpoints / surface in scope for the reference. */
  apiSurface: v.optional(v.pipe(v.string(), v.maxLength(2000))),

  // --- Review-task fields ---------------------------------------------------
  /**
   * Review: the number of the EXISTING open pull request to deep-review, on the
   * service's linked repository. Either this or {@link prUrl} identifies the target;
   * `prUrl` wins when both are present.
   */
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /**
   * Review: the full web URL of the pull request to review (e.g.
   * `https://github.com/owner/repo/pull/123`). Folded into the task description for the
   * reviewer to read; today the reviewer clones the service's linked repo and fetches the
   * PR head by number from `origin`, so a cross-repo `prUrl` is not yet resolved to a
   * different repo (a tracked follow-up — see backend/docs/adr/0023-pr-deep-review.md).
   */
  prUrl: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  /** Review: freeform focus/guidance for the reviewer (e.g. "focus on the auth changes"). */
  reviewFocus: v.optional(v.pipe(v.string(), v.maxLength(4000))),

  // --- Custom-task-type fields ----------------------------------------------
  /**
   * Values for the descriptor-driven fields a CUSTOM (deployment-registered) task type declares
   * (see `customTaskTypeSchema.fields`), keyed by each field descriptor's `key`. Sparse and
   * additive like the built-in fields above: never migrated, never touches them; the built-in
   * types leave it absent.
   *
   * The SHARED descriptor-form value bag (`form-fields.ts`), so a value is a string, a number, a
   * boolean (`checkbox`) or a `string[]` (`checkbox-group`), exactly as an initiative preset's
   * inputs are. Widening it from `string | number` is a pure widening: every existing row parses
   * unchanged, so there is nothing to migrate.
   */
  custom: v.optional(descriptorFieldValuesSchema),
})
export type TaskTypeFields = v.InferOutput<typeof taskTypeFieldsSchema>

/**
 * The BUILT-IN half of {@link taskTypeFieldsSchema}: every per-type key the platform itself
 * declares, without the deployment-owned `custom` bag.
 *
 * The two halves are patched through separate keys on {@link updateBlockSchema} because they are
 * validated by different things and by nothing in common: a built-in key is schema-typed HERE,
 * where a `custom` value is checked against the descriptor its deployment registered. Splitting
 * the bag at the request boundary is what lets each half be parsed by its own authority instead
 * of one door asserting the other's rules.
 */
export const builtinTaskTypeFieldsSchema = v.omit(taskTypeFieldsSchema, ['custom'])
export type BuiltinTaskTypeFields = v.InferOutput<typeof builtinTaskTypeFieldsSchema>

/** A kind-specific document field key on {@link taskTypeFieldsSchema}. */
export type DocKindFieldKey =
  | 'targetUsers'
  | 'successMetrics'
  | 'alternativesConsidered'
  | 'rolloutConcerns'
  | 'decisionDrivers'
  | 'consideredOptions'
  | 'whenToUse'
  | 'escalationPath'
  | 'researchQuestion'
  | 'optionsToCompare'
  | 'apiSurface'

/** Descriptor for a kind-specific document field: the key + whether it wants a multi-line input. */
export interface DocKindFieldSpec {
  readonly key: DocKindFieldKey
  /** A multi-line field renders as a textarea in the form; single-line renders as an input. */
  readonly multiline: boolean
}

/**
 * Which kind-specific fields the create-task form shows — and the author agents fold into the
 * brief — for each {@link DocKind}. A kind absent from the map has only the shared quartet
 * (`docKind`/`audience`/`targetPath`/`outlineHints`). This is the SINGLE SOURCE OF TRUTH for
 * both the conditional inputs in `AddTaskModal.vue` and the prompt fold in `document.ts`, so
 * the two can't drift.
 */
export const DOC_KIND_FIELDS: Partial<Record<DocKind, readonly DocKindFieldSpec[]>> = {
  prd: [
    { key: 'targetUsers', multiline: true },
    { key: 'successMetrics', multiline: true },
  ],
  rfc: [
    { key: 'alternativesConsidered', multiline: true },
    { key: 'rolloutConcerns', multiline: true },
  ],
  adr: [
    { key: 'decisionDrivers', multiline: true },
    { key: 'consideredOptions', multiline: true },
  ],
  runbook: [
    { key: 'whenToUse', multiline: true },
    { key: 'escalationPath', multiline: true },
  ],
  research: [
    { key: 'researchQuestion', multiline: false },
    { key: 'optionsToCompare', multiline: true },
  ],
  api: [{ key: 'apiSurface', multiline: true }],
}

export const agentStateSchema = v.picklist(['pending', 'working', 'waiting_decision', 'done'])
export type AgentState = v.InferOutput<typeof agentStateSchema>

/** Agent kinds are an open set — custom agents get free-form ids. */
export const agentKindSchema = v.pipe(v.string(), v.minLength(1))
export type AgentKind = v.InferOutput<typeof agentKindSchema>

/**
 * The `kind` slug of a CUSTOM (third-party, programmatically-registered) infra backend —
 * an environment provider or a runner pool: any lower-kebab slug that isn't one of the
 * subsystem's reserved built-ins. Shared by `environmentBackendConfigSchema` /
 * `runnerBackendConfigSchema` so the slug grammar can't drift between the two subsystems.
 * The reserved-kind `v.check` is load-bearing: it stops a wrong-shaped built-in payload
 * (e.g. `{ kind: 'kubernetes', manifest }`) from silently matching the generic custom
 * member instead of failing.
 */
export function customBackendKindSchema(reserved: readonly string[]) {
  return v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(64),
    v.regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lower-kebab slug'),
    v.check((k) => !reserved.includes(k), 'reserved backend kind'),
  )
}

// ---------------------------------------------------------------------------
// AWS EKS backend shared bits. An EKS cluster's apiserver IS a standard Kubernetes
// apiserver, so the EKS runner + environment configs are the corresponding Kubernetes
// config PLUS these two non-secret AWS fields (region + cluster name); the AWS
// credentials ride the encrypted secret bundle under the keys below. Defined here once so
// the runner (`runners.ts`) and environment (`environments.ts`) subsystems can't drift.
// The actual auth (a SigV4-presigned STS token minted from these) lives in `@cat-factory/eks`.
// ---------------------------------------------------------------------------

/** Secret-bundle key the AWS access key id is read from. */
export const EKS_ACCESS_KEY_ID_SECRET_KEY = 'awsAccessKeyId'
/** Secret-bundle key the AWS secret access key is read from. */
export const EKS_SECRET_ACCESS_KEY_SECRET_KEY = 'awsSecretAccessKey'
/** Optional secret-bundle key for an AWS session token (temporary STS credentials). */
export const EKS_SESSION_TOKEN_SECRET_KEY = 'awsSessionToken'

/** The non-secret EKS fields both the runner + environment configs add on top of the K8s shape. */
export const eksClusterFieldsSchema = v.object({
  /** AWS region of the EKS cluster — the regional STS endpoint + the SigV4 credential scope. */
  region: v.pipe(
    v.string(),
    v.trim(),
    v.regex(/^[a-z0-9-]+$/, 'must be an AWS region slug'),
    v.minLength(1),
    v.maxLength(64),
  ),
  /** EKS cluster name — bound into the presigned STS token via the signed `x-k8s-aws-id` header. */
  clusterName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /**
   * Override the STS host the apiserver token is presigned against. Defaults to the regional
   * public endpoint `sts.<region>.amazonaws.com`. Set it for a VPC/FIPS/GovCloud STS endpoint —
   * or, in the integration tests, a local EKS emulator (floci) STS endpoint. Constrained to a
   * bare `host` or `host:port` (no scheme/path/query): the value is interpolated straight into
   * the presigned URL's host + the SIGNED `host` header, so anything richer would produce a
   * malformed, unsignable token.
   */
  stsHost: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.regex(/^[a-z0-9.-]+(:[0-9]{1,5})?$/i, 'must be a bare host or host:port'),
      v.minLength(1),
      v.maxLength(255),
    ),
  ),
})
export type EksClusterFields = v.InferOutput<typeof eksClusterFieldsSchema>

export const positionSchema = v.object({
  x: v.number(),
  y: v.number(),
})
export type Position = v.InferOutput<typeof positionSchema>

/**
 * An explicit pixel size for a resizable block (a service frame today). Optional
 * on a block: when absent the board auto-sizes the frame from its contents; when
 * present it is the user's dragged size, clamped client-side to never shrink below
 * the content's natural extent. Strictly positive.
 */
export const sizeSchema = v.object({
  w: v.pipe(v.number(), v.minValue(1)),
  h: v.pipe(v.number(), v.minValue(1)),
})
export type Size = v.InferOutput<typeof sizeSchema>

/**
 * A reference to a credential by logical key. Resolves against the workspace's
 * encrypted secret bundle (supplied at registration), not an env var.
 *
 * A primitive rather than an environments-only shape: the environment manifest, the runner-pool
 * config and the Kubernetes backend's secret injections all reference credentials the same way,
 * and holding it here is what lets those modules import it without importing each other.
 */
export const environmentSecretRefSchema = v.object({
  key: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+$/), v.minLength(1), v.maxLength(64)),
})
export type EnvironmentSecretRef = v.InferOutput<typeof environmentSecretRefSchema>
