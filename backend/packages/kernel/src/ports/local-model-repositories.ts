import type { LocalRunner } from '@cat-factory/contracts'

// Persistence port for per-USER locally-run model endpoints (Ollama / LM Studio /
// llama.cpp / vLLM / a custom OpenAI-compatible server). Scoped to a single user (a
// runner lives on that person's machine), keyed by `(userId, provider)`. The optional
// `apiKeyCipher` is the system-key ciphertext of a bearer key (most local runners need
// none). Both runtimes (Cloudflare D1 + Node/local Postgres) implement this so the
// behaviour is identical everywhere.

/** A user's configured local runner endpoint at rest. */
export interface LocalModelEndpointRecord {
  /** Internal user id (`usr_*`) of the owner. */
  userId: string
  /** The runner type — also the `ModelRef.provider` a model on this endpoint resolves to. */
  provider: LocalRunner
  /** Display label (defaults to the runner's name when the user leaves it blank). */
  label: string
  /** OpenAI-compatible base URL, including the `/v1` suffix. */
  baseUrl: string
  /** System-key ciphertext of an optional bearer key (null when keyless). */
  apiKeyCipher: string | null
  /** Model ids the user enabled from this runner (surfaced in the picker). */
  models: string[]
  createdAt: number
  updatedAt: number
}

export interface LocalModelEndpointRepository {
  /** Every endpoint the user has configured. */
  listByUser(userId: string): Promise<LocalModelEndpointRecord[]>
  /** The user's endpoint for a runner, or null. */
  getByUserProvider(userId: string, provider: LocalRunner): Promise<LocalModelEndpointRecord | null>
  /** Insert or replace the user's endpoint for a runner (one per user+provider). */
  upsert(record: LocalModelEndpointRecord): Promise<void>
  /** Remove the user's endpoint for a runner. */
  remove(userId: string, provider: LocalRunner): Promise<void>
}
