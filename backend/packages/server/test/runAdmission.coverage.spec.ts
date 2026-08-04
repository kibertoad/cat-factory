import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Every HTTP route that STARTS a run has to decide whether the run is attributed to a workspace
// tier, because that tier is what the merge preset's `classRulesByRole` narrows against and what
// its `dryRunRoles` sandboxes. There is no third answer, and both wrong ones are silent: a start
// that forgets `initiatedByRole` pins none, and a run with no pinned role is INDISTINGUISHABLE
// from a schedule fire — it stays on the preset's base rules and merges, reporting nothing.
//
// That is not hypothetical. The feature shipped wired into `ExecutionController` alone, so the
// bug-hunt adopt route (a member-tier start, in a different module) minted runs that escaped both
// halves of the policy. Nothing failed: it compiled, and every behavioural test for the feature
// hand-builds its instance.
//
// So this test CLASSIFIES each call site rather than asserting a count. A new start route fails
// here until someone writes down which bucket it is in — which is the moment to think about it.
// It cannot anchor on the engine (`ExecutionService.start` is reached by schedules and loops that
// legitimately pin nothing) and it cannot be a typecheck (`initiatedByRole` is optional, and must
// stay optional for exactly those callers).
// ---------------------------------------------------------------------------

const SRC = join(import.meta.dirname, '..', 'src')

/**
 * Routes that start a run ON BEHALF OF A SIGNED-IN PERSON acting on their own board. Each must
 * pass `initiatedByRole`, and the value must come from `runInitiatorRole` rather than a hand-rolled
 * read of the gate's context — one authority for membership (ADR 0025), one shape to audit.
 */
const ATTRIBUTED = [
  'modules/execution/ExecutionController.ts',
  'modules/bugHunt/BugHuntController.ts',
]

/**
 * Routes that deliberately pin NO role, with the reason. These are not oversights and must not
 * "fix" themselves into a tier: an API key is not a workspace member, so scoping its runs to one
 * would invent an authority nobody granted. Such runs stay on the preset's base rules, which is
 * the policy that governed every run before role scoping existed.
 */
const UNATTRIBUTED: Record<string, string> = {
  'modules/publicApi/PublicApiController.ts':
    'a headless `/api/v1` start authenticates as an API KEY, not as a workspace member: it holds ' +
    'scopes rather than a tier, so there is no role to pin and guessing one would either hand it ' +
    'the widest rules in the preset or sandbox every integration in the deployment.',
}

/** Every `.ts` under `src/`, recursively. */
function sourceFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return sourceFiles(join(dir, entry.name), rel)
    return entry.name.endsWith('.ts') ? [rel] : []
  })
}

describe('run-start routes classify their initiator role', () => {
  const starters = sourceFiles(SRC).filter((rel) =>
    readFileSync(join(SRC, rel), 'utf8').includes('executionService.start('),
  )

  it('finds the start routes at all (the scan itself must not silently match nothing)', () => {
    // A rename of `executionService.start` would otherwise turn every assertion below vacuous.
    expect(starters.length).toBeGreaterThanOrEqual(3)
  })

  it('classifies every start route as attributed or deliberately unattributed', () => {
    const unclassified = starters.filter(
      (rel) => !ATTRIBUTED.includes(rel) && !(rel in UNATTRIBUTED),
    )
    expect(unclassified).toEqual([])
  })

  it('makes every attributed route pin the role through the one accessor', () => {
    for (const rel of ATTRIBUTED) {
      const source = readFileSync(join(SRC, rel), 'utf8')
      expect(starters, `${rel} no longer starts a run`).toContain(rel)
      expect(source, `${rel} must pass initiatedByRole`).toContain('initiatedByRole:')
      expect(source, `${rel} must read the role via runInitiatorRole`).toContain(
        'runInitiatorRole(c)',
      )
      // A hand-rolled read is the drift this guards: it compiles, it works, and it is a second
      // place to get the dev-open `null` fallback wrong.
      expect(source, `${rel} must not re-derive the role`).not.toContain("c.get('workspaceAccess')")
    }
  })

  it('keeps a stated reason beside every unattributed route', () => {
    for (const [rel, reason] of Object.entries(UNATTRIBUTED)) {
      expect(starters, `${rel} no longer starts a run`).toContain(rel)
      expect(reason.length, `${rel} needs a real reason, not a placeholder`).toBeGreaterThan(40)
    }
  })
})
