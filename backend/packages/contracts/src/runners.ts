import * as v from 'valibot'
import {
  environmentAuthSchemeSchema,
  environmentRequestTemplateSchema,
  environmentSecretRefSchema,
} from './environments'

// ---------------------------------------------------------------------------
// Self-hosted runner-pool wire contracts ("bring your own infra").
//
// By default the repo-operating coding jobs run in per-run Cloudflare Containers.
// An organization can instead point cat-factory at its OWN container/runner pool
// (k8s, Nomad, an internal scheduler) running the standard executor-harness
// image. The harness job protocol is fixed (`POST /run` → `GET /jobs/{id}`); what
// is org-specific is the *scheduler in front of the pool* — how a job is assigned
// to a runner and how its status is read back.
//
// So, exactly like the ephemeral-environment provider (ADR 0003), an org
// describes its pool scheduler declaratively: a manifest of HTTP request
// templates for `dispatch` / `poll` / (optional) `release`, the auth scheme for
// calling it, and a dot-path mapping from that scheduler's (arbitrary) response
// onto the canonical harness job view. One generic adapter in the worker
// interprets any manifest — no per-org code.
//
// The generic auth / request-template / secret-ref shapes are shared with the
// environment manifest (they are not environment-specific); we reuse them here
// rather than redefining them.
//
// Secret handling mirrors environments: the manifest references the pool-API
// credentials by *logical key* only; the values are supplied at registration,
// stored encrypted-at-rest in D1, and resolved in-memory at call time. The
// per-job GitHub + LLM-proxy tokens travel in the dispatch payload (the runner
// needs them) but are never logged.
// ---------------------------------------------------------------------------

/** A credential reference by logical key (shared shape with the env manifest). */
export const runnerPoolSecretRefSchema = environmentSecretRefSchema
export type RunnerPoolSecretRef = v.InferOutput<typeof runnerPoolSecretRefSchema>

/** How the worker authenticates to the org's pool scheduler API. */
export const runnerPoolAuthSchemeSchema = environmentAuthSchemeSchema
export type RunnerPoolAuthScheme = v.InferOutput<typeof runnerPoolAuthSchemeSchema>

/**
 * One HTTP call against the pool scheduler API. Generic: any method, a path
 * appended to the manifest `baseUrl`, optional query/headers and a body, all
 * supporting `{{var}}` interpolation. Variables come from a bounded namespace:
 * `{{input.jobId}}` (the cat-factory execution id the pool is keyed on) and
 * `{{input.job}}` (the full harness job spec as a JSON string — embed it raw to
 * forward the job verbatim, e.g. `{"payload":{{input.job}}}`).
 */
export const runnerPoolRequestTemplateSchema = environmentRequestTemplateSchema
export type RunnerPoolRequestTemplate = v.InferOutput<typeof runnerPoolRequestTemplateSchema>

/** The harness job lifecycle states the worker drives a job through. */
export const runnerJobStateSchema = v.picklist(['running', 'done', 'failed'])
export type RunnerJobState = v.InferOutput<typeof runnerJobStateSchema>

/**
 * Maps the pool scheduler's arbitrary status response onto the canonical job
 * view via dot-path field extraction. `statusMap` translates the scheduler's own
 * status strings onto the harness states; the result/progress/error paths pull
 * the work product out of whatever envelope the scheduler returns.
 */
export const runnerPoolResponseMappingSchema = v.object({
  /** Dot-path to the scheduler's status string (e.g. `state`, `data.phase`). */
  statusPath: v.optional(v.string()),
  /** Translate scheduler status strings → harness states. */
  statusMap: v.optional(v.array(v.object({ from: v.string(), to: runnerJobStateSchema }))),
  /** Dot-paths to live subtask counts, surfaced as "N/M done" progress. */
  progressCompletedPath: v.optional(v.string()),
  progressInProgressPath: v.optional(v.string()),
  progressTotalPath: v.optional(v.string()),
  /** Dot-paths to the finished work product. */
  prUrlPath: v.optional(v.string()),
  branchPath: v.optional(v.string()),
  summaryPath: v.optional(v.string()),
  /** Dot-path to a job-level error message (a failed job, or a structured error). */
  errorPath: v.optional(v.string()),
})
export type RunnerPoolResponseMapping = v.InferOutput<typeof runnerPoolResponseMappingSchema>

/** The full declarative description of an org's runner-pool scheduler API. */
export const runnerPoolManifestSchema = v.object({
  providerId: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/), v.minLength(1), v.maxLength(64)),
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /** Scheduler API root; dispatch/poll/release paths are appended to it. */
  baseUrl: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  auth: runnerPoolAuthSchemeSchema,
  /** Starts a job on the pool (analogous to the harness `POST /run`). */
  dispatch: runnerPoolRequestTemplateSchema,
  /** Reads a job's status (analogous to the harness `GET /jobs/{id}`). */
  poll: runnerPoolRequestTemplateSchema,
  /** Optional: frees the runner/job once the worker is done with it. */
  release: v.optional(runnerPoolRequestTemplateSchema),
  response: runnerPoolResponseMappingSchema,
})
export type RunnerPoolManifest = v.InferOutput<typeof runnerPoolManifestSchema>

/** A workspace's pool binding, as exposed to clients (never secret values). */
export const runnerPoolConnectionSchema = v.object({
  providerId: v.string(),
  label: v.string(),
  baseUrl: v.string(),
  connectedAt: v.number(),
  /** Which secret keys are set (names only), so the UI can show completeness. */
  secretKeys: v.array(v.string()),
})
export type RunnerPoolConnection = v.InferOutput<typeof runnerPoolConnectionSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Register (or replace) a workspace's runner pool. The org supplies the actual
 * per-tenant scheduler-API secret values here (write-only); they are encrypted
 * and stored in D1 and never returned. Every `secretRef.key` in the manifest
 * must have a matching entry in `secrets`.
 */
export const registerRunnerPoolSchema = v.object({
  manifest: runnerPoolManifestSchema,
  secrets: v.record(v.string(), v.string()),
})
export type RegisterRunnerPoolInput = v.InferOutput<typeof registerRunnerPoolSchema>

/** Rotate/replace the per-tenant secret bundle without re-sending the manifest. */
export const updateRunnerPoolSecretsSchema = v.object({
  secrets: v.record(v.string(), v.string()),
})
export type UpdateRunnerPoolSecretsInput = v.InferOutput<typeof updateRunnerPoolSecretsSchema>
