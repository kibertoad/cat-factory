import { describe, expect, it } from 'vitest'
import type { InputGateIssueCode } from '@cat-factory/contracts'
import { INPUT_GATE_ISSUE_CODES } from '@cat-factory/contracts'
import {
  describeInputGateIssues,
  evaluateInputGate,
  hasBlockingInputIssues,
  INPUT_GATE_SEVERITY,
  type InputGateInput,
} from './input-gate.js'

const task = (over: Partial<InputGateInput> = {}): InputGateInput => ({
  title: 'Add a retry to the webhook sender',
  description: 'The webhook sender should retry three times with exponential backoff on 5xx.',
  ...over,
})

const codes = (input: InputGateInput, mode: 'standard' | 'advisory' | 'off' = 'standard') =>
  evaluateInputGate(input, mode).issues.map((i) => i.code)

describe('INPUT_GATE_SEVERITY', () => {
  it('classifies every code in the closed vocabulary', () => {
    // The Record is exhaustive by type; this pins that the CONTRACTS list and the kernel table
    // are the same set, so a code added on one side can't be silently unclassified on the other.
    expect(Object.keys(INPUT_GATE_SEVERITY).sort()).toEqual([...INPUT_GATE_ISSUE_CODES].sort())
  })
})

describe('evaluateInputGate: description', () => {
  it('passes a real description with no findings', () => {
    const verdict = evaluateInputGate(task(), 'standard')
    expect(verdict.status).toBe('passed')
    expect(verdict.issues).toEqual([])
  })

  it('blocks an empty description', () => {
    const verdict = evaluateInputGate(task({ description: '   \n  ' }), 'standard')
    expect(verdict.status).toBe('blocked')
    expect(verdict.issues).toEqual([{ code: 'description_missing', severity: 'blocking' }])
  })

  it.each(['TBD', 'n/a', '  todo ', '...', 'See title', 'as discussed', '???'])(
    'blocks the placeholder-only description %j',
    (description) => {
      expect(codes(task({ description }))).toEqual(['description_placeholder'])
    },
  )

  it('does not treat a real description containing "TODO" as a placeholder', () => {
    const description =
      'Replace the TODO in the retry helper with a real exponential backoff implementation.'
    expect(codes(task({ description }))).toEqual([])
  })

  it('flags a very short description as ADVISORY, not blocking', () => {
    const verdict = evaluateInputGate(task({ description: 'make it faster' }), 'standard')
    expect(verdict.issues).toEqual([{ code: 'description_thin', severity: 'advisory' }])
    expect(verdict.status).toBe('passed')
  })

  it('reports at most one description finding', () => {
    // `missing` also satisfies "thin"; reporting both would ask for one thing to be fixed twice.
    expect(codes(task({ description: '' }))).toEqual(['description_missing'])
  })

  it('never accepts the title as a substitute for the description', () => {
    const long = task({ title: 'A very precise and complete title of the work', description: '' })
    expect(codes(long)).toEqual(['description_missing'])
  })
})

describe('evaluateInputGate: bug reproduction context', () => {
  const bug = (over: Partial<InputGateInput> = {}) =>
    task({ taskType: 'bug', description: 'The export button crashes the tab.', ...over })

  it('blocks a bug with neither reproduction steps nor a cue in the description', () => {
    expect(codes(bug())).toEqual(['reproduction_missing'])
  })

  it('accepts a bug whose dedicated field carries the steps', () => {
    expect(codes(bug({ taskTypeFields: { stepsToReproduce: '1. open export 2. click' } }))).toEqual(
      [],
    )
  })

  it.each([
    'Steps to reproduce: open the export panel and click Export.',
    'Expected a CSV download; actual is a blank tab.',
    'Reproduce by clicking export twice in a row.',
    'Throws an exception in the worker when the payload is empty.',
  ])('accepts a bug whose description carries the cue %j', (description) => {
    expect(codes(bug({ description }))).toEqual([])
  })

  it('accepts a bug whose description is a list of at least two steps', () => {
    const description = 'Crash on export:\n- open the panel\n- click Export\n- tab dies'
    expect(codes(bug({ description }))).toEqual([])
  })

  it('reports the description gap and the reproduction gap independently', () => {
    // Two different things to fix, in two different places, so two findings rather than one.
    expect(codes(bug({ description: '' }))).toEqual(['description_missing', 'reproduction_missing'])
  })
})

describe('evaluateInputGate: per-type targets', () => {
  it('blocks a review task naming no pull request', () => {
    expect(codes(task({ taskType: 'review' }))).toEqual(['review_target_missing'])
  })

  it.each([{ prNumber: 42 }, { prUrl: 'https://example.test/org/repo/pull/42' }])(
    'accepts a review task identified by %j',
    (taskTypeFields) => {
      expect(codes(task({ taskType: 'review', taskTypeFields }))).toEqual([])
    },
  )

  it('treats a zero pr number as no target', () => {
    expect(codes(task({ taskType: 'review', taskTypeFields: { prNumber: 0 } }))).toEqual([
      'review_target_missing',
    ])
  })

  it('flags a spike with no criteria as advisory only', () => {
    const verdict = evaluateInputGate(task({ taskType: 'spike' }), 'standard')
    expect(verdict.status).toBe('passed')
    expect(verdict.issues).toEqual([{ code: 'success_criteria_missing', severity: 'advisory' }])
  })

  it('accepts a spike stating either criteria or a research question', () => {
    expect(
      codes(task({ taskType: 'spike', taskTypeFields: { successCriteria: 'pick one' } })),
    ).toEqual([])
    expect(
      codes(task({ taskType: 'spike', taskTypeFields: { researchQuestion: 'which queue?' } })),
    ).toEqual([])
  })

  it('applies only the description checks to an unknown / deployment-registered type', () => {
    // The platform has no opinion about what somebody else's task type requires.
    expect(codes(task({ taskType: 'acme:incident' }))).toEqual([])
    expect(codes(task({ taskType: 'acme:incident', description: '' }))).toEqual([
      'description_missing',
    ])
  })
})

describe('evaluateInputGate: platform-authored tasks', () => {
  it('does not judge a recurring schedule block, whose input is the schedule', () => {
    // Its description is blank because nobody authored one and nobody ever will; parking it
    // would stall every scheduled run on a field with no owner.
    const verdict = evaluateInputGate(task({ taskType: 'recurring', description: '' }), 'standard')
    expect(verdict).toEqual({ status: 'not_applicable', mode: 'standard', issues: [] })
  })

  it('keeps `not_applicable` distinct from `off`, which is a setting somebody chose', () => {
    expect(evaluateInputGate(task({ taskType: 'recurring' }), 'off').status).toBe('off')
  })
})

describe('evaluateInputGate: modes', () => {
  it('off records NOTHING, so "nobody looked" never reads as "nothing found"', () => {
    const verdict = evaluateInputGate(task({ description: '' }), 'off')
    expect(verdict).toEqual({ status: 'off', mode: 'off', issues: [] })
  })

  it('advisory reports the same findings but never blocks', () => {
    const verdict = evaluateInputGate(task({ taskType: 'bug', description: '' }), 'advisory')
    expect(verdict.status).toBe('passed')
    expect(verdict.issues.map((i) => i.severity)).toEqual(['advisory', 'advisory'])
    expect(verdict.issues.map((i) => i.code)).toEqual([
      'description_missing',
      'reproduction_missing',
    ])
  })

  it('never promotes an intrinsically advisory finding to blocking', () => {
    const advisoryOnly = INPUT_GATE_ISSUE_CODES.filter(
      (code: InputGateIssueCode) => INPUT_GATE_SEVERITY[code] === 'advisory',
    )
    expect(advisoryOnly.length).toBeGreaterThan(0)
    const verdict = evaluateInputGate(task({ description: 'make it faster' }), 'standard')
    expect(hasBlockingInputIssues(verdict.issues)).toBe(false)
  })
})

describe('describeInputGateIssues', () => {
  it('names the blocking findings when there are any', () => {
    const verdict = evaluateInputGate(task({ taskType: 'bug', description: '' }), 'standard')
    expect(describeInputGateIssues(verdict.issues)).toBe(
      'description_missing, reproduction_missing',
    )
  })

  it('falls back to the advisory findings when nothing blocks', () => {
    const verdict = evaluateInputGate(task({ description: 'make it faster' }), 'standard')
    expect(describeInputGateIssues(verdict.issues)).toBe('description_thin')
  })
})
