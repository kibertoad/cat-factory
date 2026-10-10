import type { InitiativePresetInputs } from '@cat-factory/contracts'
import { seedPipelines } from '@cat-factory/kernel'
import { moduleSlug } from '../repo-ops/render.js'

// ---------------------------------------------------------------------------
// Shared helpers for initiative-preset `seedPlan` post-processors (docs-refresh, tech-migration, …).
// A preset's `seedPlan` stamps per-item spawn DECORATION at ingest; these are the primitives every
// such hook needs — reading a frozen form value, deriving a repo-safe `.md` filename, de-duplicating
// derived paths so no two documents target one file, and deriving the merge-step gate override.
// Kept here (one implementation) rather than copied per preset so a fix to the single-writer dedup or
// the [S2] gate-override contract lands once and can't drift between presets.
// ---------------------------------------------------------------------------

/** Read a string input, falling back to `fallback` when absent/blank/non-string. */
export function strInput(inputs: InitiativePresetInputs, key: string, fallback: string): string {
  const value = inputs[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/**
 * A filesystem-safe, lower-kebab file slug for a derived `.md` target path — the package's shared
 * {@link moduleSlug} (single slug implementation) capped to a filename-sane length. A degenerate
 * (empty / all-punctuation) title falls back to `moduleSlug`'s `module`; the caller deduplicates the
 * composed path via {@link uniqueDocPath} anyway, so two such items never collide on one file.
 */
export function fileSlug(title: string): string {
  return moduleSlug(title).slice(0, 60)
}

/**
 * Ensure a derived `.md` path is unique within one plan: on collision, insert `-2`, `-3`, … before
 * the extension (the `uniqueSlugId` pattern) and record it. Two items whose titles slug to the same
 * name under the same directory would otherwise stamp the SAME `targetPath`, spawning two doc tasks
 * that open competing PRs writing one file. Only derived paths are deduped (planner-authored
 * placement rides the item description, not `targetPath`).
 */
export function uniqueDocPath(path: string, taken: Set<string>): string {
  if (!taken.has(path)) {
    taken.add(path)
    return path
  }
  const dot = path.lastIndexOf('.')
  const base = dot === -1 ? path : path.slice(0, dot)
  const ext = dot === -1 ? '' : path.slice(dot)
  let n = 2
  let candidate = `${base}-${n}${ext}`
  while (taken.has(candidate)) candidate = `${base}-${++n}${ext}`
  taken.add(candidate)
  return candidate
}

/**
 * The per-run gate-override array that human-gates a spawned pipeline at its MERGE step — a FULL
 * boolean array parallel to the pipeline's own `agentKinds` (the [S2] gate-override contract:
 * `ExecutionService.start` rejects a length mismatch), the single `true` on the last `merger` step
 * so the human reviews the CI-green PR right BEFORE it merges. DERIVED from the pipeline's shape
 * (never a hand-maintained parallel array), so it stays correct by construction if a pipeline's
 * shape changes. `undefined` when the pipeline is unknown or has no merge step (leaving its own
 * gates untouched).
 */
export function mergeGateOverride(pipelineId: string): boolean[] | undefined {
  const kinds = seedPipelines().find((p) => p.id === pipelineId)?.agentKinds
  if (!kinds) return undefined
  const gateIdx = kinds.lastIndexOf('merger')
  if (gateIdx === -1) return undefined
  return kinds.map((_, i) => i === gateIdx)
}
