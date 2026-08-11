import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Locally-run model wire contracts. A developer running cat-factory in local
// (or self-hosted Node) mode can point agents at an LLM running on their OWN
// machine — Ollama, LM Studio, llama.cpp's `llama-server`, vLLM, or any other
// OpenAI-compatible server. All expose the OpenAI `/v1/chat/completions` +
// `/v1/models` shape, so a "runner" is just a provider id + a base URL.
//
// Endpoints are configured PER USER (a runner lives on a person's machine, so
// `localhost:11434` means something different for each member) and stored in the
// DB. At run time the LLM proxy / inline model provider resolve the base URL +
// optional key by the RUN INITIATOR — exactly like personal subscriptions.
// ---------------------------------------------------------------------------

/** The supported local runner types. The runner type IS the `ModelRef.provider`. */
export const LOCAL_RUNNERS = ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'custom'] as const
export const localRunnerSchema = v.picklist(LOCAL_RUNNERS)
export type LocalRunner = v.InferOutput<typeof localRunnerSchema>

/** Whether a provider id is one of the local runner types. */
export function isLocalRunner(provider: string): boolean {
  return (LOCAL_RUNNERS as readonly string[]).includes(provider)
}

/** Default base URL per runner, for UI prefill. `custom` has none (user supplies it). */
export const LOCAL_RUNNER_DEFAULTS: Record<LocalRunner, string | null> = {
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  llamacpp: 'http://localhost:8080/v1',
  vllm: 'http://localhost:8000/v1',
  custom: null,
}

/** Short display label per runner, shown in the picker as the provider label. */
export const LOCAL_RUNNER_LABELS: Record<LocalRunner, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp',
  vllm: 'vLLM',
  custom: 'Custom',
}

/**
 * One model a user has ENABLED on a runner, plus what they have DECLARED about it.
 *
 * The id alone is not enough, because a local model is not in the curated catalog: nothing
 * upstream knows whether `muse-glimmer:30b` reads images the way a `MODEL_CATALOG` entry's
 * flavour declares it. The OpenAI-compatible `/models` probe cannot answer it either (it
 * returns ids and nothing else), so the person who pulled the weights is the only source
 * there is, and this is where they say so.
 *
 * `acceptsImages` is deliberately THREE-STATE, mirroring `ModelRef.acceptsImages`:
 * `true` (the runner serves it with image input), `false` (declared text-only) and ABSENT
 * (nobody has said). The third is the default and is NOT a "no": a run withholds the design
 * renders either way, but reports `unknown_model_image_input` rather than
 * `model_no_image_input`, which is the difference between "declare it and this works" and
 * "this model cannot". Collapsing them would let a multimodal local model read as text-only
 * forever with nothing saying the platform never asked.
 */
export const localModelDeclarationSchema = v.object({
  /** The model id as the runner serves it (e.g. `muse-glimmer:30b`). */
  id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  /** Whether this runner serves the model with IMAGE input. Absent ⇒ not declared. */
  acceptsImages: v.optional(v.boolean()),
})
export type LocalModelDeclaration = v.InferOutput<typeof localModelDeclarationSchema>

/**
 * Why a runner base URL is refused by the deployment's local-runner policy. The SPA maps
 * each member to translated copy (`localModels.urlReason.*`), so the operator-facing
 * English the backend composes stays DETAIL rather than the description. `host_not_loopback`
 * and `host_not_local` are the same denial under the two policies and are kept apart
 * because only one of them has "an operator can allow LAN hosts" as its remedy.
 */
export const LOCAL_RUNNER_URL_REASONS = [
  'invalid_url',
  'scheme_not_allowed',
  'credentials_not_allowed',
  'query_or_fragment_not_allowed',
  'host_not_loopback',
  'host_not_local',
] as const
export const localRunnerUrlReasonSchema = v.picklist(LOCAL_RUNNER_URL_REASONS)
export type LocalRunnerUrlReason = v.InferOutput<typeof localRunnerUrlReasonSchema>

/**
 * A user's configured local runner endpoint, as returned to the SPA. The API key is
 * write-only (never returned); `hasApiKey` reports whether one is stored.
 */
export const localModelEndpointSchema = v.object({
  provider: localRunnerSchema,
  label: v.string(),
  baseUrl: v.string(),
  /** Whether a (write-only) API key is stored for this endpoint. */
  hasApiKey: v.boolean(),
  /** The models the user has enabled from this runner, with what they declared about each. */
  models: v.array(localModelDeclarationSchema),
  /**
   * Whether part of this endpoint's stored model list could not be READ and was discarded (a row
   * written before declarations existed held bare strings). Reported rather than swallowed because
   * a discarded list and a runner nobody enabled a model on are the same `models: []` and opposite
   * facts: only one of them is fixed by re-ticking, and nothing else anywhere would say so.
   */
  unreadableModels: v.boolean(),
  /**
   * Why this stored endpoint is currently unusable under the deployment's runner-URL
   * policy, or `null` when it is fine. A row written while LAN hosts were permitted must
   * not keep rendering as healthy after an operator narrows the policy: the models it
   * serves are withheld from the picker, so the panel is the only place left to say why.
   */
  urlBlockedReason: v.nullable(localRunnerUrlReasonSchema),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type LocalModelEndpoint = v.InferOutput<typeof localModelEndpointSchema>

const baseUrlSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300), v.url())
const labelSchema = v.pipe(v.string(), v.trim(), v.maxLength(60))
const apiKeySchema = v.pipe(v.string(), v.maxLength(400))

/** Create or replace the signed-in user's endpoint for a runner (one per runner). */
export const upsertLocalModelEndpointSchema = v.object({
  provider: localRunnerSchema,
  label: v.optional(labelSchema),
  baseUrl: baseUrlSchema,
  /** Optional bearer key (most local runners ignore it); stored encrypted at rest. */
  apiKey: v.optional(apiKeySchema),
  models: v.array(localModelDeclarationSchema),
})
export type UpsertLocalModelEndpointInput = v.InferOutput<typeof upsertLocalModelEndpointSchema>

/** Probe a runner endpoint for reachability + the models it currently serves. */
export const testLocalModelEndpointSchema = v.object({
  provider: localRunnerSchema,
  baseUrl: baseUrlSchema,
  apiKey: v.optional(apiKeySchema),
})
export type TestLocalModelEndpointInput = v.InferOutput<typeof testLocalModelEndpointSchema>

/** The result of probing a runner endpoint's `/models`. */
export const localModelEndpointTestResultSchema = v.object({
  reachable: v.boolean(),
  /**
   * Model ids the runner reports (empty when unreachable). Bare ids, NOT declarations: the
   * probe reads an OpenAI-compatible `/models` list, which carries no modality, and inventing
   * one here would put a guess where {@link localModelDeclarationSchema} keeps an absence.
   */
  models: v.array(v.string()),
  /** Human-readable failure reason when `reachable` is false. */
  error: v.optional(v.string()),
  /**
   * Machine-readable cause when the probe was refused by the runner-URL policy rather
   * than attempted. Absent for a genuine reachability failure, which has no vocabulary:
   * the two need different fixes (change the URL vs start the runner).
   */
  errorReason: v.optional(localRunnerUrlReasonSchema),
})
export type LocalModelEndpointTestResult = v.InferOutput<typeof localModelEndpointTestResultSchema>
