import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCode } from './coverageScan.js'

// ---------------------------------------------------------------------------
// Every path that STARTS a run has to decide whether a human is watching it in the app, because
// that is what `intakeOrigin` records and what the clarification writeback keys off: a parked
// requirements review either pushes its questions out to where the work was requested, or waits
// on an overseer in the SPA. There is no third answer.
//
// The failure mode is silent in the worst direction. `intakeOrigin` is optional and its absence
// reads as `ui`, so a start path that says NOTHING is asserting that someone is watching. That is
// not hypothetical: per-ticket tracker dispatch shipped without it, and every ticket-driven run
// that parked asked its questions of a human who was not there, while the reply channel sat open
// waiting for finding ids no comment had ever posted. Nothing failed. It compiled, the writeback
// was wired, and the two halves of the loop simply never met.
//
// So this test CLASSIFIES each call site rather than counting them, in the shape
// `runAdmission.coverage.spec.ts` established for the sibling problem (`initiatedByRole`). A new
// start path fails here until someone writes down which bucket it is in, which is the moment to
// think about it. It cannot be a typecheck: the field must stay optional, because the in-app
// start is genuinely entitled to the default.
//
// It scans BOTH packages, because half the starters are HTTP controllers and half are engine
// services. `@cat-factory/server` depends on `@cat-factory/orchestration`, so reading across from
// here respects the layering; the reverse would not.
//
// Every read goes through `coverageScan`, which strips comments first. That is load-bearing, not
// tidiness: `firePerTicket` documents its own `intakeOrigin: 'tracker'` in JSDoc, so a text match
// over the raw file stayed green with the value deleted from the call site below it.
// ---------------------------------------------------------------------------

const PACKAGES = join(import.meta.dirname, '..', '..')
const ROOTS: Record<string, string> = {
  server: join(PACKAGES, 'server', 'src'),
  orchestration: join(PACKAGES, 'orchestration', 'src'),
}

/**
 * How a run start is spelled. Most callers hold the service; `PostMergeBoardController` takes the
 * start as an injected callback, which is a legitimate seam and still a start path.
 */
const START_CALLS = ['executionService.start(', 'deps.start(']

/**
 * Starts with NO human in the app, and the origin literals each file must actually pass.
 *
 * The VALUES are asserted, not merely the presence of the field: a file that declares an
 * `intakeOrigin` parameter and then forgets to thread it at the call site still contains the
 * word, and that near-miss is the whole bug this guards.
 */
const UNATTENDED: Record<string, { origins: string[]; why: string }> = {
  'server:modules/publicApi/PublicApiController.ts': {
    origins: ["'public-api'"],
    why: 'both `/api/v1` start paths: the caller is an integration holding a key, not a person.',
  },
  'orchestration:modules/recurring/RecurringPipelineService.ts': {
    // `'ui'` belongs here too: this file also hosts run-now, which IS attended, and it states
    // that explicitly rather than falling through to the default it happens to agree with.
    origins: ["'tracker'", "'schedule'", "'ui'"],
    why:
      'per-ticket dispatch (`tracker`), the cadence sweep and the queue-drain push (`schedule`), ' +
      'and run-now (`ui`), which shares the same private `fire` and so must name itself.',
  },
}

/**
 * Starts that deliberately take the `ui` default, with the reason. These are not oversights, and
 * "it is unattended" is NOT on its own a reason to move one: what the writeback needs is a STABLE
 * place to hold a conversation, which an unattended run does not automatically have.
 */
const IN_APP: Record<string, string> = {
  'server:modules/execution/ExecutionController.ts':
    'the SPA board start. This IS the default case: a signed-in person pressing start on their ' +
    'own board, whose clarification surface is the app they are looking at.',
  'server:modules/bugHunt/BugHuntController.ts':
    'a person adopting a scanned bug from the bug-hunt panel. The tracker issue is where the bug ' +
    'came FROM, but the human who adopted it is in the app and is the one being asked.',
  'orchestration:modules/initiative/InitiativeLoopService.ts':
    'a spawned initiative child. Unattended in the moment, but its questions have nowhere else ' +
    'to go: the block is minted from the breakdown and carries no linked ticket, so the writeback ' +
    "would resolve no issues and post nothing. Propagating the initiative run's own origin would " +
    'cost a repository read per spawned item on the ticker path (the no-N+1 rule) to change ' +
    'nothing observable. Revisit if initiative children ever gain a ticket.',
  'orchestration:modules/execution/PostMergeBoardController.ts':
    "the dependent-task cascade after a merge. The dependency edge was authored on somebody's " +
    'board and the follow-on run belongs to that board, so its park raises the in-app review card ' +
    'like any other board task.',
  'orchestration:container/engine-dependent-modules.ts':
    'the blueprint pass that maps a freshly bootstrapped repo onto the board. It runs the ' +
    'blueprint-only pipeline, which has no requirements review and therefore no park to report.',
}

describe('run-start paths classify their intake origin', () => {
  const code = loadCode(ROOTS)
  const starters = [...code.entries()]
    // `ExecutionService` is the engine's own re-entry into the lifecycle, not an intake surface:
    // it forwards whatever its caller decided, which is precisely what the callers above decide.
    .filter(([key]) => !key.endsWith('modules/execution/ExecutionService.ts'))
    .filter(([, source]) => START_CALLS.some((call) => source.includes(call)))
    .map(([key]) => key)

  it('finds the start paths at all (the scan itself must not silently match nothing)', () => {
    // A rename of either spelling would otherwise turn every assertion below vacuous.
    expect(starters.length).toBeGreaterThanOrEqual(6)
  })

  it('classifies every start path as unattended or deliberately in-app', () => {
    const unclassified = starters.filter((key) => !(key in UNATTENDED) && !(key in IN_APP))
    expect(unclassified).toEqual([])
  })

  it('makes every unattended path pass the intake origins it claims to', () => {
    for (const [key, { origins, why }] of Object.entries(UNATTENDED)) {
      expect(starters, `${key} no longer starts a run`).toContain(key)
      expect(why.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(40)
      const source = code.get(key)!
      for (const origin of origins) {
        expect(source, `${key} must pass intakeOrigin: ${origin}`).toContain(
          `intakeOrigin: ${origin}`,
        )
      }
    }
  })

  it('keeps a stated reason beside every in-app path', () => {
    for (const [key, reason] of Object.entries(IN_APP)) {
      expect(starters, `${key} no longer starts a run`).toContain(key)
      expect(reason.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(60)
      // An in-app path taking the default must not ALSO set an origin: that would mean the
      // classification here and the code disagree, and the code would win silently. Comments are
      // already stripped, so a file is free to say at its call site WHY it takes the default.
      expect(code.get(key), `${key} is classified in-app but sets an origin`).not.toContain(
        'intakeOrigin:',
      )
    }
  })
})
