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
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  LocalRunner,
  LocalModelDeclaration,
  LocalModelEndpoint,
  LocalRunnerUrlReason,
  UpsertLocalModelEndpointInput,
  TestLocalModelEndpointInput,
  LocalModelEndpointTestResult,
} from '@cat-factory/contracts'

// Value re-exports (the per-runner default base URL + display labels).
export { LOCAL_RUNNER_DEFAULTS, LOCAL_RUNNER_LABELS } from '@cat-factory/contracts'

// What the platform already KNOWS about the popular local model families. The panel reads the same
// table the engine folds onto a dispatched ref, so the "not set" option can state what will happen
// instead of implying nothing will.
export { knownLocalModel } from '@cat-factory/contracts'
export type { KnownLocalModel } from '@cat-factory/contracts'
