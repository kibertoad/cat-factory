import * as v from 'valibot'
import { nonEmpty, urlString } from './primitives.js'

// ---------------------------------------------------------------------------
// Docker Compose STACK RECIPES — declarative multi-step bring-up for complex compose
// repos (the acme-main pilot). A recipe extends a `docker-compose` service's
// provisioning (see `serviceProvisioningSchema.recipe` in `environments.ts`) with
// ordered `-f` layering, `COMPOSE_PROFILES`, env-file materialization, external
// networks / shared-stack refs, and imperative setup/teardown steps + a terminal
// health gate. Every field is OPTIONAL, so an existing single-file `composePath`
// config parses unchanged. The compose provider keys purely on the PERSISTED recipe
// — autodetection and the environment analyst only RECOMMEND these fields (the
// build-flag rule).
//
// Runtime-BOUND execution (a host Docker daemon) lands local-facade-only — the documented
// compose exception to runtime symmetry — but the shape here is fully symmetric + persisted
// on the service frame like the rest of ServiceProvisioning. This same recipe shape is also
// what the environment ANALYST returns as a draft (slice 8) and the per-field basis a
// SharedStack reuses (slice 4). See docs/initiatives/stack-recipes-and-shared-stacks.md.
// ---------------------------------------------------------------------------

/**
 * A repo-relative path within the checkout (bounded, trimmed). The runtime applies the
 * checkout-escape guard (`escapesCheckout`) at execution time — the schema only bounds length,
 * because a `wait-file` path targeting a running container is legitimately container-absolute.
 */
const recipePathString = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))

/** A `COMPOSE_PROFILES` / external-network / shared-stack-ref / compose-service identifier. */
const recipeName = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/** A human label for a recipe step, surfaced per-step in the provisioning log. */
const recipeStepName = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))

/** A command argv (not a shell string). Use `['sh', '-c', '…']` when a shell is genuinely needed. */
const recipeCommand = v.pipe(v.array(nonEmpty), v.minLength(1))

/**
 * A per-step timeout budget (ms). Recipe steps run far longer than a management-API call — a
 * ~5-minute cache warmup or a 40-image ECR pull — so the ceiling is generous (up to 1h). Each
 * step gets its OWN budget, never a shared pool (the `BUILD_TIMEOUT_MS` precedent); absent ⇒
 * the engine's per-kind default.
 */
const recipeTimeoutMs = v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(3_600_000))

/** How often a `wait-*` step / health gate re-probes (ms). Absent ⇒ the engine default. */
const recipePollIntervalMs = v.pipe(v.number(), v.integer(), v.minValue(250), v.maxValue(60_000))

/** Accept only this HTTP status; absent ⇒ any 2xx. */
const recipeExpectStatus = v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599))

/** Require this substring in the HTTP response body. */
const recipeExpectBody = v.pipe(v.string(), v.maxLength(500))

/**
 * Materialize a committed template into its gitignored target inside the checkout BEFORE `up`
 * — e.g. `.env.dev.local-dist` → `.env.dev.local`, `.split.yaml.dist` → `.split.yaml`. Both
 * paths are repo-relative and must pass the runtime's checkout-escape guard.
 */
export const recipeEnvFileSchema = v.object({
  /** Committed template file read from the checkout. */
  template: recipePathString,
  /** Gitignored destination the template is copied to. */
  target: recipePathString,
})
export type RecipeEnvFile = v.InferOutput<typeof recipeEnvFileSchema>

/**
 * One ordered step in a stack recipe, discriminated by `kind`. Every step carries a `name`
 * (surfaced per-step in the provisioning log) and an optional per-step `timeoutMs`. Kinds:
 *
 * - `compose-exec`  — `docker compose exec <service> <argv…>` inside a running container
 *   (composer install, migrations, cache warmup, index builds; a seed import pipes a `.sql`
 *   dump via `stdinFile`).
 * - `copy-file`     — an in-checkout template copy (a one-off subset of `envFiles`).
 * - `wait-http`     — poll a URL until it returns the expected status / body substring.
 * - `wait-file`     — poll for a file (in the checkout, or inside `service`'s container).
 * - `host-command`  — an arbitrary command on the ORCHESTRATOR HOST. Trusted local facade
 *   ONLY, behind an explicit opt-in flag (the `build`-flag pattern) and refused by every other
 *   backend — the escape hatch for genuinely host-side steps.
 */
export const recipeStepSchema = v.variant('kind', [
  v.object({
    kind: v.literal('compose-exec'),
    name: recipeStepName,
    /** The compose `services:` key to exec inside. */
    service: recipeName,
    /** The command argv (not a shell string). */
    command: recipeCommand,
    /** Optional repo-relative file piped to the command's stdin (e.g. a `.sql` seed dump). */
    stdinFile: v.optional(recipePathString),
    /** Run as this user inside the container (`docker compose exec --user`). */
    user: v.optional(recipeName),
    /** Working directory inside the container (`--workdir`). */
    workdir: v.optional(recipePathString),
    timeoutMs: v.optional(recipeTimeoutMs),
  }),
  v.object({
    kind: v.literal('copy-file'),
    name: recipeStepName,
    /** Source template, repo-relative. */
    from: recipePathString,
    /** Destination, repo-relative. */
    to: recipePathString,
    timeoutMs: v.optional(recipeTimeoutMs),
  }),
  v.object({
    kind: v.literal('wait-http'),
    name: recipeStepName,
    /** URL to poll (typically a localhost/LAN endpoint the compose project publishes). */
    url: urlString,
    expectStatus: v.optional(recipeExpectStatus),
    expectBodyContains: v.optional(recipeExpectBody),
    intervalMs: v.optional(recipePollIntervalMs),
    timeoutMs: v.optional(recipeTimeoutMs),
  }),
  v.object({
    kind: v.literal('wait-file'),
    name: recipeStepName,
    /** Path to poll for: repo-relative in the checkout, or container-absolute when `service` is set. */
    path: recipePathString,
    /** When set, poll inside this compose service's container instead of the checkout. */
    service: v.optional(recipeName),
    intervalMs: v.optional(recipePollIntervalMs),
    timeoutMs: v.optional(recipeTimeoutMs),
  }),
  v.object({
    kind: v.literal('host-command'),
    name: recipeStepName,
    /** The command argv run on the orchestrator host (opt-in, local-facade only). */
    command: recipeCommand,
    /** Working directory on the host, repo-relative to the checkout; absent ⇒ the checkout root. */
    workdir: v.optional(recipePathString),
    timeoutMs: v.optional(recipeTimeoutMs),
  }),
])
export type RecipeStep = v.InferOutput<typeof recipeStepSchema>
export type RecipeStepKind = RecipeStep['kind']

/**
 * The recipe's TERMINAL readiness gate — polled after the setup steps until it passes or its
 * budget elapses. `compose-healthy` (the default when absent) is today's `up --wait` behaviour;
 * `http` polls a URL; `compose-exec` runs a command in a service until it exits 0 (e.g.
 * `bin/console monitor:health`).
 */
export const recipeHealthGateSchema = v.variant('kind', [
  v.object({ kind: v.literal('compose-healthy') }),
  v.object({
    kind: v.literal('http'),
    url: urlString,
    expectStatus: v.optional(recipeExpectStatus),
    expectBodyContains: v.optional(recipeExpectBody),
    intervalMs: v.optional(recipePollIntervalMs),
    timeoutMs: v.optional(recipeTimeoutMs),
  }),
  v.object({
    kind: v.literal('compose-exec'),
    service: recipeName,
    command: recipeCommand,
    intervalMs: v.optional(recipePollIntervalMs),
    timeoutMs: v.optional(recipeTimeoutMs),
  }),
])
export type RecipeHealthGate = v.InferOutput<typeof recipeHealthGateSchema>

/**
 * A declarative Docker Compose STACK RECIPE — the imperative bring-up of a complex compose
 * repo expressed as data. Extends a `docker-compose` service's provisioning; every field is
 * optional, so a plain single-file `composePath` config carries no recipe and parses
 * unchanged. Also the shape the environment ANALYST returns as a draft (slice 8) and the
 * per-field basis a SharedStack reuses (slice 4). The compose provider consumes the PERSISTED
 * recipe only — autodetection / the analyst merely recommend it.
 */
export const stackRecipeSchema = v.object({
  /** Ordered `-f` compose files (base + overrides). Supersedes `composePath` when present (⇒ non-empty). */
  composeFiles: v.optional(v.pipe(v.array(recipePathString), v.minLength(1))),
  /** `COMPOSE_PROFILES` to enable for the project. */
  composeProfiles: v.optional(v.array(recipeName)),
  /** Committed templates materialized into their gitignored targets before `up`. */
  envFiles: v.optional(v.array(recipeEnvFileSchema)),
  /** Networks the project expects to already exist (owned by a shared stack or the engine). */
  externalNetworks: v.optional(v.array(recipeName)),
  /** Ids of SharedStack entities that must be up first (slice 4). */
  sharedStackRefs: v.optional(v.array(recipeName)),
  /** Ordered post-`up` setup steps. */
  setupSteps: v.optional(v.array(recipeStepSchema)),
  /** Terminal readiness gate; absent ⇒ `compose-healthy` (today's `up --wait`). */
  healthGate: v.optional(recipeHealthGateSchema),
  /** Optional steps run before `down -v` on teardown. */
  teardownSteps: v.optional(v.array(recipeStepSchema)),
})
export type StackRecipe = v.InferOutput<typeof stackRecipeSchema>
