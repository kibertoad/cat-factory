import { describe, expect, it } from 'vitest'
import type { InputGateIssueCode } from '@cat-factory/contracts'
import { INPUT_GATE_ISSUE_CODES } from '@cat-factory/contracts'
import {
  describeInputGateIssues,
  evaluateInputGate,
  hasBlockingInputIssues,
  INPUT_GATE_SEVERITY,
  inputGateInputOf,
  type InputGateInput,
} from './input-gate.js'
import { defaultTaskTypeRegistry } from './task-type-registry.js'

const task = (over: Partial<InputGateInput> = {}): InputGateInput => ({
  title: 'Add a retry to the webhook sender',
  description: 'The webhook sender should retry three times with exponential backoff on 5xx.',
  level: 'task',
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

describe('evaluateInputGate: blocks whose description is not authored task input', () => {
  it('does not judge a recurring schedule block, whose input is the schedule', () => {
    // Its description is blank because nobody authored one and nobody ever will; parking it
    // would stall every scheduled run on a field with no owner.
    const verdict = evaluateInputGate(task({ taskType: 'recurring', description: '' }), 'standard')
    expect(verdict).toEqual({ status: 'not_applicable', mode: 'standard', issues: [] })
  })

  it.each(['frame', 'module', 'epic', 'initiative'] as const)(
    'does not judge a %s block, which stands for an entity rather than a brief',
    (level) => {
      // An initiative's planning pipeline runs against its ANCHOR block, whose description is a
      // caption; the run's real input is the initiative's goal and committed plan. Judging the
      // caption parked every initiative run on a field the flow never fills in.
      const verdict = evaluateInputGate(task({ level, description: '' }), 'standard')
      expect(verdict).toEqual({ status: 'not_applicable', mode: 'standard', issues: [] })
    },
  )

  it('still judges a task the platform SPAWNED, whose description is a real brief', () => {
    // An initiative-spawned item and a ticket-imported task are ordinary board tasks a human can
    // edit, so they get the same check as any other. What they need is an answer path without a
    // browser, which is the public decision surface, not an exemption here.
    expect(codes(task({ level: 'task', description: 'TBD' }))).toEqual(['description_placeholder'])
  })

  it('keeps `not_applicable` distinct from `off`, which is a setting somebody chose', () => {
    expect(evaluateInputGate(task({ taskType: 'recurring' }), 'off').status).toBe('off')
    expect(evaluateInputGate(task({ level: 'initiative' }), 'off').status).toBe('off')
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

  it('names WHICH field a repeatable finding is about', () => {
    // `required_field_missing` is the one code that can appear more than once, so on its own it
    // renders as the same word repeated: a count, and nothing an operator reading the log line
    // or the parked step's detail could act on. The KEY rides along (stable, greppable), not the
    // deployment's label (prose that gets re-worded).
    const verdict = evaluateInputGate(
      {
        title: 'EU shard outage',
        description: 'The EU shard started refusing writes at 14:02 and recovered at 14:19.',
        level: 'task',
        taskType: 'acme:incident',
        customFields: [
          { key: 'impact', label: 'Customer impact', required: true },
          { key: 'sev', label: 'Severity', required: true },
        ],
        taskTypeFields: { custom: {} },
      },
      'standard',
    )
    expect(describeInputGateIssues(verdict.issues)).toBe(
      'required_field_missing(impact), required_field_missing(sev)',
    )
  })
})

describe('evaluateInputGate: a custom task type’s own required fields', () => {
  const incident = (over: Partial<InputGateInput> = {}): InputGateInput =>
    task({
      taskType: 'acme:incident',
      customFields: [
        { key: 'impact', label: 'Customer impact', required: true },
        { key: 'runbook', label: 'Runbook link' },
        { key: 'sev', label: 'Severity', type: 'select', required: true },
      ],
      ...over,
    })

  it('parks on each unanswered required field, naming it', () => {
    const verdict = evaluateInputGate(incident({ taskTypeFields: { custom: {} } }), 'standard')
    // ONE finding per field: three unanswered fields are three things to go and do, and a
    // human told "a required field is missing" would fix one and be parked again.
    expect(verdict.issues.map((i) => i.field?.key)).toEqual(['impact', 'sev'])
    // The deployment-supplied label rides along, because the platform has no vocabulary of its
    // own for somebody else's task type and cannot write the sentence without it.
    expect(verdict.issues[0]?.field?.label).toBe('Customer impact')
    expect(verdict.status).toBe('blocked')
  })

  it('is satisfied by an answered field, whatever its type', () => {
    const verdict = evaluateInputGate(
      incident({ taskTypeFields: { custom: { impact: '4k users on the EU shard', sev: 'high' } } }),
      'standard',
    )
    expect(verdict.status).toBe('passed')
    expect(verdict.issues).toEqual([])
  })

  it('treats whitespace and an empty list as unanswered', () => {
    // The same `isFilled` rule the create form applies, so the two doors cannot disagree about
    // what counts as an answer.
    const verdict = evaluateInputGate(
      incident({
        customFields: [
          { key: 'areas', label: 'Affected areas', type: 'checkbox-group', required: true },
        ],
        taskTypeFields: { custom: { areas: [] } },
      }),
      'standard',
    )
    expect(verdict.issues.map((i) => i.field?.key)).toEqual(['areas'])
  })

  it('never requires a field its own showWhen would have HIDDEN', () => {
    // The trap worth pinning: a form that never showed the field cannot have asked for it, so
    // parking here would name an input with nowhere to go and fill it in.
    const verdict = evaluateInputGate(
      incident({
        customFields: [
          { key: 'external', label: 'Customer facing', type: 'checkbox' },
          {
            key: 'statusPage',
            label: 'Status page URL',
            required: true,
            showWhen: { key: 'external', equals: true },
          },
        ],
        taskTypeFields: { custom: {} },
      }),
      'standard',
    )
    expect(verdict.status).toBe('passed')

    // …and requires it the moment the condition is met.
    const shown = evaluateInputGate(
      incident({
        customFields: [
          { key: 'external', label: 'Customer facing', type: 'checkbox' },
          {
            key: 'statusPage',
            label: 'Status page URL',
            required: true,
            showWhen: { key: 'external', equals: true },
          },
        ],
        taskTypeFields: { custom: { external: true } },
      }),
      'standard',
    )
    expect(shown.issues.map((i) => i.field?.key)).toEqual(['statusPage'])
  })

  it('finds nothing for a namespaced type no deployment registered', () => {
    // Stale data after an extension was removed. A gone registration declares nothing, which is
    // the honest answer: inventing a requirement for a type nothing can describe would park a
    // run on a field no form will ever offer.
    const verdict = evaluateInputGate(
      task({ taskType: 'acme:incident', taskTypeFields: { custom: {} } }),
      'standard',
    )
    expect(verdict.status).toBe('passed')
  })

  it('is softened by advisory mode like every other finding', () => {
    const verdict = evaluateInputGate(incident({ taskTypeFields: { custom: {} } }), 'advisory')
    expect(verdict.status).toBe('passed')
    expect(verdict.issues.every((i) => i.severity === 'advisory')).toBe(true)
  })

  it('stacks with the description checks rather than replacing them', () => {
    const verdict = evaluateInputGate(
      incident({ description: '', taskTypeFields: { custom: {} } }),
      'standard',
    )
    expect(verdict.issues.map((i) => i.code)).toEqual([
      'description_missing',
      'required_field_missing',
      'required_field_missing',
    ])
  })
})

describe('inputGateInputOf', () => {
  it('resolves a custom type’s declared fields off the registry', () => {
    // The ONE mapping every evaluation site goes through, which is why the registry is a
    // REQUIRED argument: a call site that could omit it would silently judge a deployment's
    // task type as declaring nothing, and nothing about that reads as wrong.
    const registry = defaultTaskTypeRegistry()
    registry.register({
      taskType: 'acme:incident',
      presentation: {
        label: 'Incident',
        icon: 'i-lucide-siren',
        color: 'red',
        description: 'An incident.',
      },
      fields: [{ key: 'impact', label: 'Customer impact', required: true }],
    })
    const input = inputGateInputOf(
      {
        title: 'Shard outage',
        description: 'x'.repeat(40),
        level: 'task',
        taskType: 'acme:incident',
      },
      registry,
    )
    expect(input.customFields?.map((f) => f.key)).toEqual(['impact'])
    expect(evaluateInputGate(input, 'standard').status).toBe('blocked')
  })

  it('resolves nothing for a BUILT-IN type, which declares no descriptor fields', () => {
    const input = inputGateInputOf(
      { title: 'Retry webhooks', description: 'x'.repeat(40), level: 'task', taskType: 'feature' },
      defaultTaskTypeRegistry(),
    )
    expect(input.customFields).toBeUndefined()
  })

  it('stands down for a type whose bespoke formPanel owns the whole bag', () => {
    // The second of the two stand-downs this shares with the CREATE door
    // (`taskTypeCreationDefaults`'s `checkCustomFields`), and the one with no other test: a
    // `formPanel` type's descriptor fields are not what its bespoke section collected, so
    // requiring them would park a run on inputs the form it was authored in never offered.
    // The doors agreeing is the entire argument for reading the existing declaration instead of
    // adding a second one, so a drift here is the argument quietly failing.
    const registry = defaultTaskTypeRegistry()
    const presentation = {
      label: 'Incident',
      icon: 'i-lucide-siren',
      color: 'red',
      description: 'An incident.',
    }
    const fields = [{ key: 'impact', label: 'Customer impact', required: true }]
    registry.register({ taskType: 'acme:incident', presentation, fields, formPanel: 'acme:form' })
    const block = {
      title: 'Shard outage',
      description: 'x'.repeat(40),
      level: 'task' as const,
      taskType: 'acme:incident',
    }
    expect(inputGateInputOf(block, registry).customFields).toBeUndefined()
    expect(evaluateInputGate(inputGateInputOf(block, registry), 'standard').status).toBe('passed')

    // ...and the SAME declaration without the panel is required, so the stand-down is what is
    // being asserted rather than the fields being unreadable.
    const plain = defaultTaskTypeRegistry()
    plain.register({ taskType: 'acme:incident', presentation, fields })
    expect(evaluateInputGate(inputGateInputOf(block, plain), 'standard').status).toBe('blocked')
  })
})
