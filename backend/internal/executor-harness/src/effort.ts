import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// The agent effort self-assessment side channel. Every container agent is asked
// (via the backend-composed system prompt) to end its run by writing a short JSON
// self-assessment — how hard the work was, what reduced its effectiveness, the key
// obstacles — to a sentinel file in its working directory. The harness reads it after
// the agent finishes, removes it (so it never lands in a commit), and forwards it on
// the job result; the backend records it on the step and surfaces it in run details.
//
// The filename is kept in sync with `EFFORT_REPORT_FILE` in `@cat-factory/agents`
// (the executor-harness has no dependency on that package), exactly like CONTEXT_DIR
// and the follow-ups sentinel. The shape mirrors the contracts `AgentEffortReport`.
// ---------------------------------------------------------------------------

/** The sentinel file the agent writes its effort self-assessment to (relative to its cwd). */
export const EFFORT_REPORT_FILE = '.cat-effort.json'

/** A container agent's self-assessment of the work it just did. */
export interface EffortReport {
  /** How hard the work was: 1 (trivial) .. 10 (extremely hard). */
  difficulty: number
  /** One or two sentences on how hard/easy the work was and why. */
  summary?: string
  /** What reduced the agent's effectiveness. */
  reducedEffectiveness?: string
  /** The key obstacles the agent hit. */
  obstacles?: string[]
}

/**
 * Read + parse + REMOVE the agent's effort sentinel file from `cwd`. Lenient: returns undefined
 * when the file is absent (the agent wrote none), unreadable, not JSON, or carries nothing
 * meaningful. Never throws — a malformed self-report must never fail an otherwise-good run.
 */
export async function readEffortReport(cwd: string): Promise<EffortReport | undefined> {
  const path = join(cwd, EFFORT_REPORT_FILE)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined // no report written — the common case
  }
  // Remove it so it never lands in a commit (defence in depth; the backend also excludes it).
  await rm(path, { force: true }).catch(() => {})
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return coerceEffort(parsed)
}

/** Coerce arbitrary parsed JSON into a clean {@link EffortReport}, or undefined when it carries nothing. */
function coerceEffort(value: unknown): EffortReport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  const report: EffortReport = { difficulty: clampDifficulty(o.difficulty) }
  if (typeof o.summary === 'string' && o.summary.trim()) {
    report.summary = o.summary.trim().slice(0, 2000)
  }
  if (typeof o.reducedEffectiveness === 'string' && o.reducedEffectiveness.trim()) {
    report.reducedEffectiveness = o.reducedEffectiveness.trim().slice(0, 2000)
  }
  if (Array.isArray(o.obstacles)) {
    const obstacles = o.obstacles
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim().slice(0, 500))
      .slice(0, 20)
    if (obstacles.length) report.obstacles = obstacles
  }
  // Nothing beyond a defaulted difficulty ⇒ the agent didn't really report anything; drop it so
  // run details don't show an empty "5/10, no detail" card for a stray/blank file.
  if (
    report.summary === undefined &&
    report.reducedEffectiveness === undefined &&
    report.obstacles === undefined &&
    !isFiniteNumber(o.difficulty)
  ) {
    return undefined
  }
  return report
}

function clampDifficulty(v: unknown): number {
  const n = isFiniteNumber(v)
    ? v
    : typeof v === 'string' && v.trim() !== ''
      ? Number(v)
      : Number.NaN
  if (!Number.isFinite(n)) return 5
  return Math.min(10, Math.max(1, Math.round(n)))
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
