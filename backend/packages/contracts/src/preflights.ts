import * as v from 'valibot'
import { urlString } from './primitives.js'

// ---------------------------------------------------------------------------
// PREFLIGHTS — machine-prerequisite checks with guided remediation. A stack
// recipe (see `stack-recipes.ts`) declares the checks that apply to it
// (`prerequisites: PreflightRef[]`); each check is a PROBE that is automated
// (docker daemon reachable, disk/RAM, registry login state, VPN reachability,
// mkcert CA, /etc/hosts entries, an env-file secrets marker) plus REMEDIATION
// that is human instructions — this is exactly where the inherently-manual
// one-time machine setup (VPN / SSO / Vault / mkcert) lives, as guided steps
// rather than pretend-automation.
//
// The probes are runtime-BOUND to a host (they read the local Docker daemon /
// filesystem / network), so they run on the local facade — the documented
// compose exception to runtime symmetry — but the DECLARATION here is fully
// symmetric + rides the existing `provisioning` blob (no migration). Checks are
// re-run at provision start: a failed REQUIRED check fails the provision fast
// with its remediation text in the provisioning log, instead of a mid-provision
// mystery deep inside a 40-image pull. They are also surfaced in the setup
// wizard (slice 7) with a live re-check button. See
// docs/initiatives/stack-recipes-and-shared-stacks.md.
// ---------------------------------------------------------------------------

/**
 * The built-in preflight checks (the local-facade probe implementations). Leaf values mirror the
 * check id verbatim so a dynamic i18n/lookup is total:
 * - `docker-daemon`       — the host Docker daemon is reachable.
 * - `disk-space`          — free disk ≥ `minGib` (a heavy stack wants headroom for images/volumes).
 * - `memory`             — total RAM ≥ `minGib` (acme wants ≥16 GiB).
 * - `registry-auth`      — `docker login` state for `registry` (detects an expired ECR token BEFORE
 *   a 40-image pull fails; we check, never store, credentials).
 * - `tcp-reachable`      — a TCP connect to `host:port` succeeds (a VPN-only Vault/ECR host).
 * - `http-reachable`     — an HTTP GET of `url` returns the expected status/body.
 * - `mkcert-ca`          — the mkcert local CA is present in the trust store.
 * - `hosts-entries`      — every hostname in `hostnames` is present in the hosts file.
 * - `env-secrets-marker` — `file` contains `marker` (e.g. acme's `# BOF SECRETS #` block — detects
 *   "the Vault step hasn't been run yet" without knowing anything about Vault).
 */
export const preflightCheckIdSchema = v.picklist([
  'docker-daemon',
  'disk-space',
  'memory',
  'registry-auth',
  'tcp-reachable',
  'http-reachable',
  'mkcert-ca',
  'hosts-entries',
  'env-secrets-marker',
])
export type PreflightCheckId = v.InferOutput<typeof preflightCheckIdSchema>

/** A host / registry / path / hostname / marker identifier a preflight probe reads (bounded). */
const preflightString = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))

/**
 * Per-check parameters. A single flat bag (every field optional) rather than a per-kind variant —
 * a check reads only the fields it needs, and the preflight service fails a check with a clear
 * "misconfigured" verdict when a required param for its kind is missing. Keeps a hand-authored /
 * analyst-drafted `PreflightRef` lenient to parse.
 */
export const preflightParamsSchema = v.object({
  /** `disk-space` / `memory`: the minimum required, in GiB. */
  minGib: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1024))),
  /** `registry-auth`: the registry host to check `docker login` state for. */
  registry: v.optional(preflightString),
  /** `tcp-reachable`: the host to connect to. */
  host: v.optional(preflightString),
  /** `tcp-reachable`: the port to connect to. */
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  /** `http-reachable`: the URL to GET. */
  url: v.optional(urlString),
  /** `http-reachable`: require exactly this HTTP status; absent ⇒ any 2xx. */
  expectStatus: v.optional(v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599))),
  /** `http-reachable`: require this substring in the response body. */
  expectBodyContains: v.optional(v.pipe(v.string(), v.maxLength(500))),
  /** `hosts-entries`: the hostnames that must be present in the hosts file. */
  hostnames: v.optional(v.array(preflightString)),
  /** `env-secrets-marker`: the host path to read. */
  file: v.optional(preflightString),
  /** `env-secrets-marker`: the substring that must be present in `file`. */
  marker: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
})
export type PreflightParams = v.InferOutput<typeof preflightParamsSchema>

/**
 * One preflight check a recipe declares (`stackRecipeSchema.prerequisites`). `check` selects the
 * built-in probe; `params` feeds it; `required` (default true) decides whether a failure BLOCKS the
 * provision (a non-required check is advisory — a warning); `remediation` overrides the built-in
 * instructions; `label` overrides the built-in title.
 */
export const preflightRefSchema = v.object({
  check: preflightCheckIdSchema,
  params: v.optional(preflightParamsSchema),
  /** A failing REQUIRED check blocks the provision; a non-required one is advisory. Default true. */
  required: v.optional(v.boolean()),
  /** Operator override of the built-in remediation markdown (shown on a non-pass verdict). */
  remediation: v.optional(v.pipe(v.string(), v.maxLength(4000))),
  /** Operator override of the built-in check title. */
  label: v.optional(preflightString),
})
export type PreflightRef = v.InferOutput<typeof preflightRefSchema>

/** A preflight verdict: `pass` (satisfied) / `fail` (blocking when required) / `warn` (advisory). */
export const preflightStatusSchema = v.picklist(['pass', 'fail', 'warn'])
export type PreflightStatus = v.InferOutput<typeof preflightStatusSchema>

/**
 * One evaluated check's outcome — the wizard's checklist row and the provision-start log entry.
 * `remediation` is present on a non-pass verdict (the operator override or the built-in default),
 * carrying the copy-paste instructions to fix it.
 */
export const preflightResultSchema = v.object({
  check: preflightCheckIdSchema,
  /** The resolved title (the ref's `label` override, or the built-in title). */
  title: v.string(),
  status: preflightStatusSchema,
  /** Whether a failure of this check blocks the provision (the ref's `required`, defaulted). */
  required: v.boolean(),
  /** A short probe detail (free disk, HTTP status, the connect error). */
  detail: v.optional(v.string()),
  /** The remediation markdown, present on a non-pass verdict. */
  remediation: v.optional(v.string()),
})
export type PreflightResult = v.InferOutput<typeof preflightResultSchema>
