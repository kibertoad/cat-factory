import { defaultAgentKindRegistry, shippedBasePromptFor } from '@cat-factory/agents'
import { SANDBOX_FIXTURE_KINDS } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  baselinePromptText,
  listBaselines,
  SANDBOX_AGENT_KINDS,
  sandboxKindMeta,
  statesMissingCheckout,
} from './baselines.js'
import { rubricFor, SANDBOX_TASK_TYPES } from './rubrics.js'

const registry = defaultAgentKindRegistry()

describe('SANDBOX_AGENT_KINDS', () => {
  it('declares each kind once, with a rubric the package ships', () => {
    const kinds = SANDBOX_AGENT_KINDS.map((m) => m.agentKind)
    expect(new Set(kinds).size).toBe(kinds.length)
    for (const meta of SANDBOX_AGENT_KINDS) {
      expect(SANDBOX_TASK_TYPES, `${meta.agentKind} rubric`).toContain(meta.rubric)
      expect(rubricFor(meta.rubric).dimensions.length).toBeGreaterThan(0)
    }
  })

  it('ties the un-runnable reason to the run mode in both directions', () => {
    // The refusal message has ONE home so the create endpoint, the run-driver and the SPA's
    // disabled option cannot disagree. A kind marked unsupported with no reason leaves each of
    // them to invent one; a reason on a runnable kind reads as a refusal that never fires.
    for (const meta of SANDBOX_AGENT_KINDS) {
      if (meta.sandboxRun === 'unsupported') {
        expect(meta.unsupportedReason, `${meta.agentKind} needs a reason`).toBeTruthy()
      } else {
        expect(meta.unsupportedReason, `${meta.agentKind} should have no reason`).toBeNull()
      }
    }
  })

  it('names fixture kinds the contract accepts, and claims at least one per kind', () => {
    for (const meta of SANDBOX_AGENT_KINDS) {
      expect(meta.fixtureKinds.length, `${meta.agentKind} claims no fixture kind`).toBeGreaterThan(
        0,
      )
      for (const kind of meta.fixtureKinds) expect(SANDBOX_FIXTURE_KINDS).toContain(kind)
    }
  })

  it('does not let two kinds claim the same fixture kind', () => {
    // The library is filtered BY fixture kind, so an overlap would offer one agent's fixtures to
    // another and grade them on the wrong rubric.
    const claimed = SANDBOX_AGENT_KINDS.flatMap((m) => [...m.fixtureKinds])
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('flags exactly the kinds whose composed prompt claims a checkout they will not get', () => {
    // A container kind the Sandbox runs inline is told, by its own composed system prompt, to diff
    // a branch and read the changed files. The driver must state the absence rather than grade the
    // candidate on failing to do something impossible.
    const flagged = SANDBOX_AGENT_KINDS.filter(statesMissingCheckout).map((m) => m.agentKind)
    expect(flagged).toEqual(['reviewer'])
    for (const meta of SANDBOX_AGENT_KINDS) {
      if (statesMissingCheckout(meta)) {
        expect(meta.bucket).toBe('container')
        expect(meta.sandboxRun).toBe('inline')
      }
    }
  })
})

describe('baselinePromptText', () => {
  it('is the unit an override REPLACES, not the composed prompt', () => {
    // The whole promotion story: a candidate cloned from a baseline must be droppable straight into
    // the workspace prompt editor. Reading the text off `PROMPT_VERSIONS` instead handed the inline
    // ENGINE kinds their COMPOSED prompt (role plus directives), so promoting a candidate doubled
    // the directives. Asserted against `shippedBasePromptFor`, which is what the editor shows.
    for (const meta of SANDBOX_AGENT_KINDS) {
      const { text } = baselinePromptText(meta, registry)
      expect(text, `${meta.agentKind} base text`).toBe(
        shippedBasePromptFor(meta.agentKind, registry),
      )
      expect(text.length).toBeGreaterThan(0)
    }
  })

  it('labels a numbered prompt id@vN and an unnumbered one kind@v1', () => {
    expect(baselinePromptText(sandboxKindMeta('requirements-review')!, registry).label).toMatch(
      /^requirement-review@v\d+$/,
    )
    expect(baselinePromptText(sandboxKindMeta('requirements-writer')!, registry).label).toMatch(
      /^requirement-writer@v\d+$/,
    )
    expect(baselinePromptText(sandboxKindMeta('task-estimator')!, registry).label).toBe(
      'task-estimator@v1',
    )
  })
})

describe('listBaselines', () => {
  it('synthesizes one un-persisted version 0 per catalog kind', () => {
    const baselines = listBaselines(1_700_000_000_000, registry)
    expect(baselines).toHaveLength(SANDBOX_AGENT_KINDS.length)
    for (const baseline of baselines) {
      expect(baseline.origin).toBe('baseline')
      expect(baseline.version).toBe(0)
      expect(baseline.parentId).toBeNull()
      expect(baseline.id).toBe(baseline.lineageId)
      expect(baseline.systemText.length).toBeGreaterThan(0)
    }
    // Ids are what a matrix references, so a collision would silently run one kind's prompt for
    // another. `basePromptId ?? agentKind` keys them, and both halves must stay distinct.
    const ids = baselines.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
