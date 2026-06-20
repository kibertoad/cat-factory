import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type PiRunOutcome,
  type PiRunStats,
  runPi,
  webSearchConfigFromEnv,
  webSearchProxyEnv,
  writeAgentsContext,
  writePiModelsConfig,
  writeWebToolsConfig,
} from './pi.js'
import type { RunOptions } from './runner.js'

// The thin base every container agent shares: an ephemeral working directory, and
// one Pi run inside it driven by the harness-written context. The agents differ in
// how the directory is prepared (clone a branch, scaffold from scratch, read files
// to build the prompt) and what they do with the result (push a branch, open a PR,
// render files, return JSON) — but the middle (write AGENTS.md + provider config,
// run Pi, tear the workspace down) is identical, so it lives here once. Carries no
// secrets beyond the call: the per-job tokens arrive in the spec and are gone when
// the workspace is removed.

/**
 * Run `fn` against a fresh temp working directory, always removing it afterwards
 * (even on throw). `prefix` labels the directory (e.g. 'impl', 'merge').
 */
export async function withWorkspace<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** What every agent needs to drive Pi against an already-prepared directory. */
export interface AgentRunSpec {
  /** The prepared working directory (cloned/scaffolded by the caller). */
  dir: string
  /** Composed role + best-practice fragments; written to Pi's global AGENTS.md context. */
  systemPrompt: string
  /** The concrete task prompt handed to Pi. */
  userPrompt: string
  model: string
  proxyBaseUrl: string
  sessionToken: string
  /**
   * For a monorepo service, the subdirectory (relative to the repo root) this run
   * operates within — `spec.dir` already points there. Surfaced to the agent in
   * AGENTS.md so it knows it's in a monorepo and where its service lives. Absent ⇒
   * whole-repo run (no monorepo note).
   */
  serviceDirectory?: string
  /**
   * Whether this run is expected to edit files. Defaults to true; set false for
   * assess-only runs (the merger) so the no-progress guard's no-edit bound — which
   * would otherwise fire on a run that correctly makes zero edits — is skipped.
   */
  expectsEdits?: boolean
  /**
   * Per-kind web-search guidance composed by the backend (so it can speak to what
   * this agent kind does). Surfaced in AGENTS.md only when web search is configured;
   * absent ⇒ the generic blurb is used. See `writeAgentsContext`.
   */
  webToolsGuidance?: string
  /**
   * Enable proxy-backed web search: point the rpiv-web-tools SearXNG provider at the
   * backend's search proxy (`${proxyBaseUrl}/web-search`) with the session token as
   * the bearer — so the search runs server-side under the deployment's key and no
   * provider secret reaches the sandbox. Off ⇒ web search is on only if a provider key
   * is present directly in the container env (the self-hosted runner-pool path).
   */
  webSearchProxy?: boolean
}

/**
 * Write Pi's global agent context (`~/.pi/agent/AGENTS.md`) + provider config,
 * then run Pi once in `spec.dir` and return its summary/stats/stderr. The context
 * lives outside the checkout so it never lands in a commit; the shared middle of
 * every container agent.
 */
export async function runAgentInWorkspace(
  spec: AgentRunSpec,
  opts: RunOptions = {},
): Promise<PiRunOutcome> {
  // Opt-in web search/fetch (rpiv-web-tools). Two ways it turns on, both no-ops by
  // default:
  //  - proxy-backed (the Cloudflare/managed path): the backend set `webSearchProxy`,
  //    so point the SearXNG provider at `${proxyBaseUrl}/web-search` with the session
  //    token — the search runs server-side, no provider key in the sandbox.
  //  - direct (the self-hosted runner-pool path): a provider key is present in the
  //    container env, which `webSearchConfigFromEnv` autodetects.
  // The proxy vars are handed to Pi's child via `extraEnv` (not the harness's own
  // process.env), so detection runs against the same merged view the extension sees.
  const extraEnv: Record<string, string> = spec.webSearchProxy
    ? webSearchProxyEnv(spec.proxyBaseUrl, spec.sessionToken)
    : {}
  const webSearch = webSearchConfigFromEnv({ ...process.env, ...extraEnv })
  if (webSearch) await writeWebToolsConfig(webSearch)
  await writeAgentsContext(spec.systemPrompt, {
    webSearch: Boolean(webSearch),
    guidance: spec.webToolsGuidance,
    serviceDirectory: spec.serviceDirectory,
  })
  await writePiModelsConfig({ model: spec.model, proxyBaseUrl: spec.proxyBaseUrl })
  const { signal, onActivity, onProgress } = opts
  return runPi({
    cwd: spec.dir,
    model: spec.model,
    userPrompt: spec.userPrompt,
    sessionToken: spec.sessionToken,
    signal,
    onActivity,
    onProgress,
    expectsEdits: spec.expectsEdits ?? true,
    extraEnv,
  })
}

/**
 * True when Pi exited cleanly without a single tool call or token of output — the
 * signature of a run where it never reached the model. Used by every agent's
 * no-op reason to point at the most likely cause (an unreachable proxy / rejected
 * model) rather than a genuine "nothing to do".
 */
export function agentNeverActed(stats: PiRunStats): boolean {
  return stats.toolCalls === 0 && stats.assistantChars === 0
}

/** The full-sentence "never acted" cause shared by the structured no-op reasons. */
export const NEVER_ACTED_CAUSE =
  ' The agent never acted (no tool calls, no model output) — it most likely could not reach the model.'

/**
 * The credential-scrubbed tail where a no-op's real cause shows up: a slice of Pi's
 * stderr, or — when stderr is empty — a slice of its summary. Empty when neither is
 * present. Shared by every agent's no-op reason so the cause is always diagnosable
 * without shelling into the (ephemeral) container.
 */
export function agentOutputTail(stderrTail: string | undefined, summary?: string): string {
  if (stderrTail) return ` Agent stderr: ${stderrTail.slice(-700)}`
  if (summary) return ` Agent output: ${summary.slice(0, 700)}`
  return ''
}
