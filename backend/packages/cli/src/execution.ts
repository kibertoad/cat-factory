import {
  CONTAINER_RUNTIMES,
  type ExecutionMode,
  NATIVE_HARNESSES,
  type NativeHarness,
} from './templates.js'

// Execution-mode helpers for the local-mode bootstrap: the pool-vs-native choice, the
// tradeoff copy shown before the prompt, the native-harness metadata, and the curated
// subset of models that actually run natively. Kept dependency-free (the CLI only pulls
// in @clack/prompts at runtime), so the model list below is a small static mirror of the
// backend catalog rather than an import.

/** A native subscription harness: the CLI it drives + a picker label. */
export interface NativeHarnessInfo {
  harness: NativeHarness
  /** The CLI that must already be installed AND logged in on the host. */
  cli: string
  label: string
}

export const NATIVE_HARNESS_INFO: Record<NativeHarness, NativeHarnessInfo> = {
  'claude-code': {
    harness: 'claude-code',
    cli: 'claude',
    label: 'Claude Code (drives your `claude` CLI — Anthropic Claude)',
  },
  codex: {
    harness: 'codex',
    cli: 'codex',
    label: 'Codex (drives your `codex` CLI — OpenAI ChatGPT)',
  },
}

/** A catalog model that runs through a native ambient CLI in native mode. */
export interface NativeModel {
  /** Catalog id stored on a block (e.g. `claude-opus`). */
  id: string
  label: string
  /** Which native harness serves it. */
  harness: NativeHarness
}

/**
 * The native-capable subset of `@cat-factory/agents`' MODEL_CATALOG: models whose
 * subscription harness is a NATIVE vendor (Claude via `claude-code`, ChatGPT via `codex`).
 * Vendors that merely REUSE the `claude-code` harness against their own endpoint
 * (GLM/Kimi/DeepSeek) are deliberately excluded — they still run in a container.
 * Informational only, so a small hand-maintained mirror is acceptable; keep it in step
 * with the backend catalog when the flagship models change.
 */
export const NATIVE_MODELS: NativeModel[] = [
  { id: 'claude-opus', label: 'Claude Opus 4.8', harness: 'claude-code' },
  { id: 'claude-sonnet', label: 'Claude Sonnet 4.6', harness: 'claude-code' },
  { id: 'gpt-5.5', label: 'GPT-5.5', harness: 'codex' },
  { id: 'gpt-5.4', label: 'GPT-5.4', harness: 'codex' },
]

/** The models that run natively for the given set of enabled native harnesses. */
export function nativeModelsFor(harnesses: readonly NativeHarness[]): NativeModel[] {
  const enabled = new Set(harnesses)
  return NATIVE_MODELS.filter((m) => enabled.has(m.harness))
}

/** A one-line `Label (id)` summary of the applicable native models, for `.env` comments. */
export function nativeModelSummary(harnesses: readonly NativeHarness[]): string {
  const models = nativeModelsFor(harnesses)
  if (models.length === 0) return 'none'
  return models.map((m) => `${m.label} (${m.id})`).join(', ')
}

/** The tradeoff blurb shown before the execution-mode prompt, keyed by mode. */
export const EXECUTION_MODE_TRADEOFFS: Record<ExecutionMode, string[]> = {
  pool: [
    'Prewarmed Docker pool (recommended default)',
    `  + Isolated & sandboxed — the agent runs in a container (${CONTAINER_RUNTIMES.join('/')}).`,
    '  + Works with EVERY model (Cloudflare, direct keys, all subscriptions).',
    '  + A warm pool keeps containers ready so runs start fast (configured in the UI).',
    '  - Needs a container runtime up + the executor image pulled (~GBs).',
  ],
  native: [
    'Native host agents',
    '  + No container — runs as a host process driving your OWN installed claude/codex CLI.',
    '  + Uses your existing subscription login (no leased credential, no API key).',
    '  + Fast start, no image to pull for the native steps.',
    '  - NO sandbox: the agent runs with your full host access.',
    '  - Only Claude (claude-code) and ChatGPT (codex) models go native; every other',
    '    model still runs in a container, so the executor image is still needed for those.',
    '  - The chosen CLI must already be installed and logged in on this machine.',
  ],
}

/** All native harnesses (both), for the "enable both" default. */
export const ALL_NATIVE_HARNESSES: NativeHarness[] = [...NATIVE_HARNESSES]
