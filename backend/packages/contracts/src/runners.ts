import * as v from 'valibot'
import {
  environmentAuthSchemeSchema,
  environmentRequestTemplateSchema,
  environmentSecretRefSchema,
} from './environments.js'
import { customBackendKindSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// Self-hosted runner-pool wire contracts ("bring your own infra").
//
// By default the repo-operating coding jobs run in per-run Cloudflare Containers.
// An organization can instead point cat-factory at its OWN container/runner pool
// (k8s, Nomad, an internal scheduler) running the standard executor-harness
// image. The harness job protocol is fixed (`POST /jobs` with the kind in the body
// → `GET /jobs/{id}`); what is org-specific is the *scheduler in front of the pool*
// — how a job is assigned to a runner and how its status is read back.
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
  /**
   * Dot-path to the WHOLE structured result object the harness records (the
   * harness `result`: `{ prUrl, branch, summary, service, spec, assessment, report,
   * defaultBranch, pushed, resolved, usage }`). A pool that proxies the cat-factory
   * executor-harness verbatim should set this so EVERY structured product — the
   * blueprint tree, the spec doc, the merge assessment, the test report, the bootstrap
   * default branch — is forwarded, not just the PR url/branch/summary scalars. Known
   * fields are coerced by type; unknown ones are ignored. The individual scalar paths
   * above still apply (and override) for schedulers that surface them out-of-envelope.
   */
  resultPath: v.optional(v.string()),
  /**
   * Dot-path to the array of forward-looking follow-up / question items the Coder streamed
   * since the last poll (the harness `followUps` drain-on-read channel). A pool that proxies
   * the cat-factory executor-harness verbatim should set this to `followUps` so the
   * Follow-up companion lights up live on a pool-backed coder run too (otherwise it simply
   * never streams — the engine still gates on whatever items did arrive). Each entry is
   * coerced to `{ kind, title, detail?, suggestedAction? }`.
   */
  followUpsPath: v.optional(v.string()),
  /** Dot-path to a job-level error message (a failed job, or a structured error). */
  errorPath: v.optional(v.string()),
  /**
   * Dot-path to the harness's STRUCTURED failure cause on a failed job (the harness
   * `failureCause`: `inactivity-timeout` | `max-duration` | `agent` | `git` | `api` |
   * `no-usable-output` | `no-changes`). A pool that proxies the cat-factory executor-harness
   * verbatim should set this to `failureCause` so the engine classifies the failure WITHOUT
   * regex-matching the error string — exactly like a Cloudflare container. Absent ⇒ the engine
   * falls back to the (still-stable) error-string regex.
   */
  failureCausePath: v.optional(v.string()),
  /**
   * Dot-path to the harness's extended, redacted failure `detail` (phase-timing breakdown,
   * last-tool breadcrumb) on a failed job, distinct from the one-line error. Surfaced as the
   * failure detail on the board. A verbatim-proxy pool should set this to `detail`.
   */
  detailPath: v.optional(v.string()),
})
export type RunnerPoolResponseMapping = v.InferOutput<typeof runnerPoolResponseMappingSchema>

// ---------------------------------------------------------------------------
// Kubernetes runner backend.
//
// A native runner backend that runs each run's executor-harness in a per-run Pod
// on the org's Kubernetes cluster (target k8s 1.35+) and reaches the harness HTTP
// server through the kube-apiserver POD-PROXY subresource — so the orchestrator
// needs only HTTPS to the apiserver (no in-cluster networking, no per-run Service).
// Unlike the manifest pool, this is NOT a declarative HTTP template: kube-apiserver
// does not proxy job dispatch/poll to the harness, so a native transport drives it.
// The ServiceAccount bearer token lives in the encrypted secret bundle (key
// `apiToken`); everything non-secret is config here.
// ---------------------------------------------------------------------------

/** CPU/memory pair for a pod resource request or limit (k8s quantity strings). */
export const kubernetesResourceQuantitiesSchema = v.object({
  cpu: v.optional(v.string()),
  memory: v.optional(v.string()),
})
export type KubernetesResourceQuantities = v.InferOutput<typeof kubernetesResourceQuantitiesSchema>

/** The secret-bundle key the Kubernetes backend reads the ServiceAccount token from. */
export const KUBERNETES_RUNNER_TOKEN_SECRET_KEY = 'apiToken'

export const kubernetesRunnerConfigSchema = v.object({
  /** Human label for the connection (shown in the UI). */
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /** kube-apiserver root URL, e.g. `https://my-cluster.example:6443`. */
  apiServerUrl: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  /** Namespace the per-run pods are created in. */
  namespace: v.pipe(
    v.string(),
    v.trim(),
    v.regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'must be a valid Kubernetes namespace'),
  ),
  /** PEM CA bundle to verify the apiserver TLS cert (omit only for a publicly-trusted CA). */
  caCertPem: v.optional(v.string()),
  /** Skip apiserver TLS verification — strongly discouraged; kind/dev clusters only. */
  insecureSkipTlsVerify: v.optional(v.boolean()),
  /** The executor-harness image the pod runs (the `default` image variant). */
  image: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  /** The heavier UI-tester image (Playwright), used for `image:'ui'` dispatches. */
  imageUi: v.optional(v.string()),
  /** Container port the harness HTTP server listens on (default 8080). */
  harnessPort: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  /** Name of an `imagePullSecrets` entry for a private registry. */
  imagePullSecretName: v.optional(v.string()),
  /** ServiceAccount the pod runs as (NOT the token used to call the apiserver). */
  serviceAccountName: v.optional(v.string()),
  /** Default pod resource requests/limits applied to every run pod. */
  resources: v.optional(
    v.object({
      requests: v.optional(kubernetesResourceQuantitiesSchema),
      limits: v.optional(kubernetesResourceQuantitiesSchema),
    }),
  ),
  /** Per-instance-size limit overrides (t-shirt InstanceSize → cpu/memory). */
  resourcesBySize: v.optional(v.record(v.string(), kubernetesResourceQuantitiesSchema)),
  /** Pod `nodeSelector`. */
  nodeSelector: v.optional(v.record(v.string(), v.string())),
  /** Pod tolerations (passed through to the pod spec verbatim). */
  tolerations: v.optional(v.array(v.record(v.string(), v.unknown()))),
  /** Extra pod metadata labels. */
  labels: v.optional(v.record(v.string(), v.string())),
  /** Extra pod metadata annotations. */
  annotations: v.optional(v.record(v.string(), v.string())),
})
export type KubernetesRunnerConfig = v.InferOutput<typeof kubernetesRunnerConfigSchema>

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

/** Built-in runner backend kinds the contract knows by name. */
export const RESERVED_RUNNER_BACKEND_KINDS = ['manifest', 'kubernetes'] as const

/**
 * The `kind` slug of a CUSTOM (third-party, programmatically-registered) runner backend:
 * any lower-kebab slug that isn't a reserved built-in. A custom runner backend rides the
 * generic `runnerPoolManifestSchema` body — its scheduler endpoints/secret refs live there
 * exactly like the manifest built-in — and the registered `RunnerBackendProvider` (resolved
 * by `kind`) builds the real transport. The reserved-kind guard stops a wrong-shaped
 * built-in payload from silently matching this generic member instead of failing.
 */
export const customRunnerBackendKindSchema = customBackendKindSchema(RESERVED_RUNNER_BACKEND_KINDS)

/**
 * An "agent runner backend" config, discriminated by `kind`. This is the universal
 * abstraction over WHERE repo-operating coding jobs run: the built-ins `manifest` (the BYO
 * HTTP scheduler pool) and `kubernetes` (native per-run pods), plus any CUSTOM kind a
 * deployment registers programmatically via `registerRunnerBackend` (it rides the generic
 * manifest member — NO new variant needed). Mirrors `environmentBackendConfigSchema`; the
 * provider-registry seam keys on `kind`.
 */
export const runnerBackendConfigSchema = v.variant('kind', [
  v.object({ kind: v.literal('manifest'), manifest: runnerPoolManifestSchema }),
  v.object({ kind: v.literal('kubernetes'), kubernetes: kubernetesRunnerConfigSchema }),
  v.object({ kind: customRunnerBackendKindSchema, manifest: runnerPoolManifestSchema }),
])
export type RunnerBackendConfig = v.InferOutput<typeof runnerBackendConfigSchema>
export type RunnerBackendKind = RunnerBackendConfig['kind']

/** A workspace's runner-backend binding, as exposed to clients (never secret values). */
export const runnerPoolConnectionSchema = v.object({
  /** Which backend kind is configured (`manifest` | `kubernetes` | …). */
  kind: v.string(),
  providerId: v.string(),
  label: v.string(),
  baseUrl: v.string(),
  connectedAt: v.number(),
  /** Which secret keys are set (names only), so the UI can show completeness. */
  secretKeys: v.array(v.string()),
  /**
   * The stored discriminated backend config, sans secrets (those live in the
   * write-only secret bundle), so the connect form can prefill its non-secret fields
   * on edit instead of forcing a full re-entry. Omitted only for a legacy/unparsable row.
   */
  config: v.optional(runnerBackendConfigSchema),
})
export type RunnerPoolConnection = v.InferOutput<typeof runnerPoolConnectionSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Register (or replace) a workspace's runner backend. `config` is the discriminated
 * backend config (manifest pool or Kubernetes); the org supplies the actual
 * per-tenant secret values here (write-only) — a manifest's scheduler-API
 * credentials, or a Kubernetes ServiceAccount token (`apiToken`). Secrets are
 * encrypted at rest and never returned. Every secret key the chosen backend
 * references must have a matching entry in `secrets`.
 */
export const registerRunnerPoolSchema = v.object({
  config: runnerBackendConfigSchema,
  secrets: v.record(v.string(), v.string()),
})
export type RegisterRunnerPoolInput = v.InferOutput<typeof registerRunnerPoolSchema>

/** Rotate/replace the per-tenant secret bundle without re-sending the manifest. */
export const updateRunnerPoolSecretsSchema = v.object({
  secrets: v.record(v.string(), v.string()),
})
export type UpdateRunnerPoolSecretsInput = v.InferOutput<typeof updateRunnerPoolSecretsSchema>

/**
 * Test (probe) a runner-backend connection before saving: supply the candidate
 * discriminated `config` + its `secrets`. Nothing is persisted by a test.
 */
export const testRunnerPoolConnectionSchema = v.object({
  config: v.optional(runnerBackendConfigSchema),
  secrets: v.optional(v.record(v.string(), v.string())),
})
export type TestRunnerPoolConnectionInput = v.InferOutput<typeof testRunnerPoolConnectionSchema>
