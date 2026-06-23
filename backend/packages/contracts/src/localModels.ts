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
 * A user's configured local runner endpoint, as returned to the SPA. The API key is
 * write-only (never returned); `hasApiKey` reports whether one is stored.
 */
export const localModelEndpointSchema = v.object({
  provider: localRunnerSchema,
  label: v.string(),
  baseUrl: v.string(),
  /** Whether a (write-only) API key is stored for this endpoint. */
  hasApiKey: v.boolean(),
  /** The model ids the user has enabled from this runner (surfaced in the picker). */
  models: v.array(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type LocalModelEndpoint = v.InferOutput<typeof localModelEndpointSchema>

const baseUrlSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300), v.url())
const labelSchema = v.pipe(v.string(), v.trim(), v.maxLength(60))
const apiKeySchema = v.pipe(v.string(), v.maxLength(400))
const modelIdSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/** Create or replace the signed-in user's endpoint for a runner (one per runner). */
export const upsertLocalModelEndpointSchema = v.object({
  provider: localRunnerSchema,
  label: v.optional(labelSchema),
  baseUrl: baseUrlSchema,
  /** Optional bearer key (most local runners ignore it); stored encrypted at rest. */
  apiKey: v.optional(apiKeySchema),
  models: v.array(modelIdSchema),
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
  /** Model ids the runner reports (empty when unreachable). */
  models: v.array(v.string()),
  /** Human-readable failure reason when `reachable` is false. */
  error: v.optional(v.string()),
})
export type LocalModelEndpointTestResult = v.InferOutput<typeof localModelEndpointTestResultSchema>
