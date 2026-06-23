// ---------------------------------------------------------------------------
// Per-user "local model runners" — a developer running cat-factory in local (or
// self-hosted Node) mode can point agents at an LLM running on their OWN machine
// (Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible server). A runner
// is just a provider id + a base URL, configured PER USER (a runner lives on a
// person's machine) and surfaced automatically in the per-workspace model picker.
//
// Mirrors the `@cat-factory/contracts` `localModels` schemas exactly, so a payload
// returned by the backend drops straight into the Pinia store without translation.
// ---------------------------------------------------------------------------

/** The supported local runner types. The runner type IS the `ModelRef.provider`. */
export type LocalRunner = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'custom'

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
export interface LocalModelEndpoint {
  provider: LocalRunner
  label: string
  baseUrl: string
  /** Whether a (write-only) API key is stored for this endpoint. */
  hasApiKey: boolean
  /** The model ids the user has enabled from this runner (surfaced in the picker). */
  models: string[]
  createdAt: number
  updatedAt: number
}

/** Create or replace the signed-in user's endpoint for a runner (one per runner). */
export interface UpsertLocalModelEndpointInput {
  provider: LocalRunner
  label?: string
  baseUrl: string
  /** Optional bearer key (most local runners ignore it); stored encrypted at rest. */
  apiKey?: string
  models: string[]
}

/** Probe a runner endpoint for reachability + the models it currently serves. */
export interface TestLocalModelEndpointInput {
  provider: LocalRunner
  baseUrl: string
  apiKey?: string
}

/** The result of probing a runner endpoint's `/models`. */
export interface LocalModelEndpointTestResult {
  reachable: boolean
  /** Model ids the runner reports (empty when unreachable). */
  models: string[]
  /** Human-readable failure reason when `reachable` is false. */
  error?: string
}
