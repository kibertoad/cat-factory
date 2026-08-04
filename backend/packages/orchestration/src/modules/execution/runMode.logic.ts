import type { Logger, RunMode, WorkspaceRole } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Pure resolution of a run's MODE — whether the run may land its work, or is a sandbox that
// does everything up to and including opening its pull request and then stops.
//
// Two inputs decide it: what the caller ASKED for, and whether the task's merge preset lists the
// initiator's role among the roles it sandboxes. Kept pure and separate from the engine so the
// composition rule below is stated once and testable on its own.
// ---------------------------------------------------------------------------

/** What settled a run's mode, recorded so a run can explain a sandbox it did not ask for. */
export type RunModeSource = 'requested' | 'role_policy' | 'default'

export interface RunModeResolution {
  mode: RunMode
  source: RunModeSource
}

/**
 * Resolve the mode a run starts in.
 *
 * The composition is deliberately ONE-WAY: a request for `dry_run` is honoured, and a role the
 * preset sandboxes is forced to `dry_run` whatever it asked for. There is no way to ask out of a
 * policy sandbox, because a setting a run can decline is advisory, and this one exists precisely
 * for the case where the person starting the run is not the person deciding what may land.
 *
 * The mirror image is just as deliberate: being sandboxed by policy is reported as
 * `role_policy` rather than folded into `requested`. A person who asked for a live run and got a
 * sandbox needs to know it was policy, not a mis-click, and needs it named — otherwise the only
 * available reading of their run is that the product ignored them.
 *
 * An unattributed run (no pinned role: a schedule fire, a public-API start, auth-disabled dev)
 * cannot match a role entry and so is never force-sandboxed. That is the same call the role-scoped
 * class rules make, for the same reason: absent is not a tier, and treating it as the lowest one
 * would sandbox every scheduled run in a deployment the day it first sandboxes a role.
 */
export function resolveRunMode(input: {
  requested: RunMode | undefined
  role: WorkspaceRole | null | undefined
  dryRunRoles: readonly WorkspaceRole[] | undefined
}): RunModeResolution {
  const { requested, role, dryRunRoles } = input
  if (role && dryRunRoles?.includes(role)) return { mode: 'dry_run', source: 'role_policy' }
  if (requested === 'dry_run') return { mode: 'dry_run', source: 'requested' }
  return { mode: 'live', source: 'default' }
}

/**
 * The advisory a sandboxed run carries on `ExecutionInstance.notes`, or none.
 *
 * A sandbox nobody ASKED for is the one disposition that has to announce itself: from the board, a
 * run that will never merge looks exactly like one that simply has not got there yet. A run whose
 * initiator chose `dry_run` needs no note — they know — so only `role_policy` produces one.
 *
 * It lives here rather than at the call site so the decision and how it is REPORTED cannot drift
 * apart: a future source that also surprises the initiator gets its note by extending this
 * function, not by remembering to add a branch in the engine.
 */
export function runModeStartNotes(source: RunModeSource): string[] {
  if (source !== 'role_policy') return []
  return [
    "Sandboxed run: this task's merge policy holds your role to dry runs, so the pipeline will " +
      'open a pull request but nothing will be merged.',
  ]
}

/**
 * Whether a run is sandboxed. A helper rather than `=== 'dry_run'` scattered across the merge
 * path, so the several places that must refuse to land work all read the mode the same way — and
 * so a run persisted before the mode existed (absent ⇒ `live`) can never be mistaken for one.
 */
export function isDryRun(mode: RunMode | undefined): boolean {
  return mode === 'dry_run'
}

/**
 * Settle a starting run's mode and everything that has to be SAID about it: the decision itself,
 * the advisory it contributes to the run's `notes`, and the operator log line for a sandbox the
 * initiator did not ask for.
 *
 * The three belong together — each is about the same disposition, and splitting them is how a
 * future mode source ends up decided but never reported — and none of them needs anything the
 * engine owns beyond a way to read the task's sandboxed roles. So the preset read arrives as a
 * bound callback rather than a repository, keeping this module free of the merge-policy layer and
 * testable with no engine at all.
 */
export async function settleRunModeForStart(input: {
  requested: RunMode | undefined
  role: WorkspaceRole | null | undefined
  /** Reads the task's resolved preset for the roles it sandboxes; called at most once. */
  loadDryRunRoles: () => Promise<readonly WorkspaceRole[] | undefined>
  /** Notes the run already carries, which the advisory JOINS rather than replaces. */
  baseNotes: readonly string[]
  logger: Logger
  fields: Record<string, unknown>
}): Promise<{ mode: RunMode; notes: string[] }> {
  const { mode, source } = resolveRunMode({
    requested: input.requested,
    role: input.role,
    dryRunRoles: await input.loadDryRunRoles(),
  })
  if (source === 'role_policy') {
    input.logger.info('run sandboxed by role policy', { ...input.fields, role: input.role })
  }
  return { mode, notes: [...input.baseNotes, ...runModeStartNotes(source)] }
}
