import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCode } from './coverageScan.js'

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
//
// Reads go through `coverageScan`, so every assertion below sees CODE and not prose. A guard that
// matches raw text is satisfied by a file that merely NAMES the literal it is supposed to pass,
// which is how the sibling `intakeOrigin` spec stayed green over a call site missing its value.
// ---------------------------------------------------------------------------

const ROOTS: Record<string, string> = { server: join(import.meta.dirname, '..', 'src') }

/**
 * How a run start is spelled on an HTTP route. Both belong here for the same reason: a single-kind
 * start (`startAgentKind`) goes through the identical admission and takes the identical
 * `initiatedByRole` off `RunStartOptions`, so a route using only that spelling is exactly as able
 * to mint a policy-escaping run as one using `start` — and would be invisible to this scan. Kept
 * in step with the sibling `intakeOrigin.coverage.spec.ts`, which classifies the same call sites
 * for the other silent field.
 */
const START_CALLS = ['executionService.start(', 'executionService.startAgentKind(']

/**
 * Routes that start a run ON BEHALF OF A SIGNED-IN PERSON acting on their own board. Each must
 * pass `initiatedByRole`, and the value must come from `runInitiatorRole` rather than a hand-rolled
 * read of the gate's context — one authority for membership (ADR 0025), one shape to audit.
 */
const ATTRIBUTED = [
  'server:modules/execution/ExecutionController.ts',
  'server:modules/bugHunt/BugHuntController.ts',
]

/**
 * Routes that start a run for whoever a public-API KEY is BOUND to. They pin a role too, but they
 * cannot read it the way {@link ATTRIBUTED} does: `/api/v1` has no `mountAuthGate` (a key is
 * admitted by scope, not by membership), so there is no published access object on the context and
 * the one identity a key can name has to be resolved through `keyInitiatorRole`.
 *
 * This bucket did not exist while a key could only be a machine. It does now because a key may be
 * bound to its minter, and a bound key's run IS that person's run: leaving it unattributed would
 * let a headless start land what its own holder could not land from the board. An UNBOUND key still
 * resolves `null` inside that accessor, which is the same base-rules policy every run had before
 * role scoping existed — so the old reason survives as the accessor's `null` branch rather than as
 * a whole route's exemption.
 */
const KEY_BOUND = ['server:modules/publicApi/PublicApiController.ts']

/**
 * Routes that deliberately pin NO role, with the reason. These are not oversights and must not
 * "fix" themselves into a tier. Empty today: the one member was the public-API start, which now
 * resolves the binding instead (see {@link KEY_BOUND}). Kept, with its assertions, because the
 * NEXT such route is what this guard exists to make someone think about — a schedule fire or a
 * sweeper-driven start has no person behind it at all.
 */
const UNATTRIBUTED: Record<string, string> = {}

describe('run-start routes classify their initiator role', () => {
  const code = loadCode(ROOTS)
  const starters = [...code.entries()]
    .filter(([, source]) => START_CALLS.some((call) => source.includes(call)))
    .map(([key]) => key)

  it('finds the start routes at all (the scan itself must not silently match nothing)', () => {
    // A rename of either spelling would otherwise turn every assertion below vacuous.
    expect(starters.length).toBeGreaterThanOrEqual(3)
  })

  it('classifies every start route as attributed, key-bound, or deliberately unattributed', () => {
    const unclassified = starters.filter(
      (key) => !ATTRIBUTED.includes(key) && !KEY_BOUND.includes(key) && !(key in UNATTRIBUTED),
    )
    expect(unclassified).toEqual([])
  })

  it('makes every attributed route pin the role through the one accessor', () => {
    for (const key of ATTRIBUTED) {
      const source = code.get(key)!
      expect(starters, `${key} no longer starts a run`).toContain(key)
      expect(source, `${key} must pass initiatedByRole`).toContain('initiatedByRole:')
      expect(source, `${key} must read the role via runInitiatorRole`).toContain(
        'runInitiatorRole(c)',
      )
      // A hand-rolled read is the drift this guards: it compiles, it works, and it is a second
      // place to get the dev-open `null` fallback wrong.
      expect(source, `${key} must not re-derive the role`).not.toContain("c.get('workspaceAccess')")
    }
  })

  it('makes every key-bound route resolve the role through the one accessor', () => {
    for (const key of KEY_BOUND) {
      const source = code.get(key)!
      expect(starters, `${key} no longer starts a run`).toContain(key)
      expect(source, `${key} must pass initiatedByRole`).toContain('initiatedByRole:')
      expect(source, `${key} must resolve it via keyInitiatorRole`).toContain('keyInitiatorRole(')
      // Same drift as above, one layer out: `loadWorkspaceAccess` is reachable from here, and
      // calling it directly would be a second membership resolution to keep in step with ADR 0025.
      expect(source, `${key} must not re-derive membership`).not.toContain('loadWorkspaceAccess(')
    }
  })

  it('makes EVERY start route pin a role in some classified way', () => {
    // The bucket lists are hand-maintained, so this is the assertion that stops one going stale in
    // the lenient direction: a route named as attributed or key-bound but no longer passing the
    // field would satisfy its own bucket's membership check and nothing else.
    for (const key of [...ATTRIBUTED, ...KEY_BOUND]) {
      expect(code.get(key), `${key} must still pin a role`).toContain('initiatedByRole:')
    }
  })

  it('keeps a stated reason beside every unattributed route', () => {
    for (const [key, reason] of Object.entries(UNATTRIBUTED)) {
      expect(starters, `${key} no longer starts a run`).toContain(key)
      expect(reason.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(40)
    }
  })
})
