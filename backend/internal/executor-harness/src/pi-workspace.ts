import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type PiRunOutcome,
  type PiRunStats,
  runPi,
  writeAgentsContext,
  writePiModelsConfig,
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
   * Whether this run is expected to edit files. Defaults to true; set false for
   * assess-only runs (the merger) so the no-progress guard's no-edit bound — which
   * would otherwise fire on a run that correctly makes zero edits — is skipped.
   */
  expectsEdits?: boolean
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
  await writeAgentsContext(spec.systemPrompt)
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
