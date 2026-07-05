import * as v from 'valibot'
import { urlString } from './primitives.js'
import { recipeEnvFileSchema, recipeHealthGateSchema, recipeStepSchema } from './stack-recipes.js'

// ---------------------------------------------------------------------------
// SHARED STACKS — a workspace-scoped, long-lived compose stack that runs ONCE
// per workspace/machine and that per-PR consumer environments attach to over an
// external Docker network (the acme-shared-services pilot: MySQL / Postgres /
// Valkey / RabbitMQ / Kafka / ES / Mailpit / Envoy, brought up once and reused
// across every run + PR).
//
// This is the compose analogue of the k8s helm `scope: 'shared'` singleton: it is
// NEVER swept with a run and NEVER TTL-reaped — teardown is a deliberate user
// action. Its bring-up reuses the STACK RECIPE vocabulary (`composeFiles`,
// `composeProfiles`, `envFiles`, `setupSteps`, `healthGate` — see
// `stack-recipes.ts`), plus a set of `managedNetworks` it creates + owns so
// consumers can attach to them as `external: true` (slice 5).
//
// Persistence is fully runtime-symmetric (D1 ⇄ Drizzle + a conformance
// round-trip), like every other workspace library; the actual bring-up
// (ensureUp/teardown) is runtime-BOUND to the local facade's host Docker daemon —
// the documented compose exception to runtime symmetry. See
// docs/initiatives/stack-recipes-and-shared-stacks.md.
// ---------------------------------------------------------------------------

/** A human name / compose-project / network / profile identifier for a shared stack. */
const stackName = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/** A repo-relative path within the stack's checkout (bounded, trimmed). */
const stackPathString = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))

/** A branch / tag / sha the stack repo is read at. */
const stackRef = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/**
 * A shared stack's lifecycle status:
 * - `stopped` — never brought up, or explicitly torn down (the initial state).
 * - `starting` — an `ensureUp` is in progress (clone → networks → up → setup → health).
 * - `running` — up and past its health gate; consumers may attach.
 * - `failed` — the last `ensureUp` failed; see `lastError`.
 */
export const sharedStackStatusSchema = v.picklist(['stopped', 'starting', 'running', 'failed'])
export type SharedStackStatus = v.InferOutput<typeof sharedStackStatusSchema>

/**
 * A workspace-scoped, long-lived compose stack. The recipe-shaped bring-up fields mirror
 * {@link stackRecipeSchema}'s (`composeFiles` / `composeProfiles` / `envFiles` / `setupSteps`
 * / `healthGate`); `managedNetworks` are the Docker networks this stack creates + owns (e.g.
 * `acme-net`) that per-PR consumers attach to. `status`/`lastError` are the lifecycle state.
 */
export const sharedStackSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  name: stackName,
  /** The git repo the stack is cloned from (its compose files + templates live here). */
  cloneUrl: urlString,
  /** Branch / tag / sha to read at; absent ⇒ the repo's default branch. */
  gitRef: v.nullable(stackRef),
  /** Ordered `-f` compose files (repo-relative). At least one. */
  composeFiles: v.pipe(v.array(stackPathString), v.minLength(1)),
  /** `COMPOSE_PROFILES` to enable for the stack. */
  composeProfiles: v.array(stackName),
  /** Committed templates materialized into their gitignored targets before `up`. */
  envFiles: v.array(recipeEnvFileSchema),
  /** Networks the stack creates + owns (`docker network create`), consumers attach to these. */
  managedNetworks: v.array(stackName),
  /** Ordered post-`up` setup steps (users sync, connector registration, seed import, …). */
  setupSteps: v.array(recipeStepSchema),
  /** Terminal readiness gate; absent ⇒ `compose-healthy` (`up --wait` semantics). */
  healthGate: v.nullable(recipeHealthGateSchema),
  /**
   * Opt-in to the stack's `host-command` setup steps — the one trust-boundary-widening step
   * kind (runs an arbitrary argv on the orchestrator host, not in a container). Off by default.
   */
  allowHostCommands: v.boolean(),
  status: sharedStackStatusSchema,
  /** The last bring-up failure's message (a step's error tail), or null. */
  lastError: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type SharedStack = v.InferOutput<typeof sharedStackSchema>

// ---- Request bodies -------------------------------------------------------

/** Create a new shared stack in a workspace. */
export const createSharedStackSchema = v.object({
  name: stackName,
  cloneUrl: urlString,
  gitRef: v.optional(stackRef),
  composeFiles: v.pipe(v.array(stackPathString), v.minLength(1)),
  composeProfiles: v.optional(v.array(stackName), []),
  envFiles: v.optional(v.array(recipeEnvFileSchema), []),
  managedNetworks: v.optional(v.array(stackName), []),
  setupSteps: v.optional(v.array(recipeStepSchema), []),
  healthGate: v.optional(recipeHealthGateSchema),
  allowHostCommands: v.optional(v.boolean(), false),
})
export type CreateSharedStackInput = v.InferOutput<typeof createSharedStackSchema>

/** Patch an existing shared stack (all fields optional). */
export const updateSharedStackSchema = v.object({
  name: v.optional(stackName),
  cloneUrl: v.optional(urlString),
  gitRef: v.optional(v.nullable(stackRef)),
  composeFiles: v.optional(v.pipe(v.array(stackPathString), v.minLength(1))),
  composeProfiles: v.optional(v.array(stackName)),
  envFiles: v.optional(v.array(recipeEnvFileSchema)),
  managedNetworks: v.optional(v.array(stackName)),
  setupSteps: v.optional(v.array(recipeStepSchema)),
  healthGate: v.optional(v.nullable(recipeHealthGateSchema)),
  allowHostCommands: v.optional(v.boolean()),
})
export type UpdateSharedStackInput = v.InferOutput<typeof updateSharedStackSchema>
