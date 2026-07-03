import type { Block, Initiative, InitiativePlanDraft } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  applyAnalysis,
  applyInterviewAnswer,
  applyInterviewOutcome,
  applyInterviewQuestions,
  applyPlanDraft,
  assertInitiativeShapeAllowed,
  coerceInterviewOutput,
  deriveCurrentPhase,
  initiativeProgress,
  initiativeSlug,
  interviewAtCap,
  validatePlanDraft,
} from './initiative.logic.js'

const block = (level: Block['level']): Block => ({
  id: 'blk-1',
  title: 'B',
  type: 'service',
  description: '',
  position: { x: 0, y: 0 },
  status: 'planned',
  progress: 0,
  dependsOn: [],
  executionId: null,
  level,
  parentId: null,
})

const emptyEntity = (): Initiative => ({
  id: 'initv-1',
  blockId: 'blk-1',
  slug: 'migrate',
  title: 'Migrate',
  goal: '',
  constraints: [],
  nonGoals: [],
  qa: [],
  analysisSummary: '',
  phases: [],
  items: [],
  policy: null,
  decisions: [],
  deviations: [],
  followUps: [],
  caveats: [],
  status: 'planning',
  rev: 0,
  createdAt: 1,
  updatedAt: 1,
})

const draft = (overrides: Partial<InitiativePlanDraft> = {}): InitiativePlanDraft => ({
  goal: 'Do the thing',
  constraints: [],
  nonGoals: [],
  analysisSummary: '',
  phases: [{ id: 'p1', title: 'Phase one', goal: '' }],
  items: [
    { id: 'a', phaseId: 'p1', title: 'Item A', description: '', dependsOn: [] },
    { id: 'b', phaseId: 'p1', title: 'Item B', description: '', dependsOn: ['a'] },
  ],
  policy: {
    maxConcurrent: 2,
    rules: [],
    defaultPipelineId: 'pl_full',
    onMissingEstimate: 'default',
  },
  decisions: [{ title: 'A decision', detail: '' }],
  caveats: [],
  ...overrides,
})

describe('assertInitiativeShapeAllowed', () => {
  it('refuses the initiative pipeline on a non-initiative block (start AND retry share it)', () => {
    expect(() =>
      assertInitiativeShapeAllowed(block('task'), ['initiative-planner', 'initiative-committer']),
    ).toThrowError(/initiative block/)
  })

  it('refuses a standard pipeline on an initiative block', () => {
    expect(() =>
      assertInitiativeShapeAllowed(block('initiative'), ['coder', 'merger']),
    ).toThrowError(/pl_initiative/)
  })

  it('allows the matching pairings', () => {
    expect(() =>
      assertInitiativeShapeAllowed(block('initiative'), [
        'initiative-planner',
        'initiative-committer',
      ]),
    ).not.toThrow()
    expect(() => assertInitiativeShapeAllowed(block('task'), ['coder', 'merger'])).not.toThrow()
  })
})

describe('validatePlanDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(() => validatePlanDraft(draft())).not.toThrow()
  })

  it('rejects duplicate ids, unknown phase refs, unknown deps and cycles', () => {
    expect(() =>
      validatePlanDraft(
        draft({
          items: [
            { id: 'a', phaseId: 'p1', title: 'A', description: '', dependsOn: [] },
            { id: 'a', phaseId: 'p1', title: 'A2', description: '', dependsOn: [] },
          ],
        }),
      ),
    ).toThrowError(/Duplicate item/)
    expect(() =>
      validatePlanDraft(
        draft({
          items: [{ id: 'a', phaseId: 'nope', title: 'A', description: '', dependsOn: [] }],
        }),
      ),
    ).toThrowError(/unknown phase/)
    expect(() =>
      validatePlanDraft(
        draft({
          items: [{ id: 'a', phaseId: 'p1', title: 'A', description: '', dependsOn: ['ghost'] }],
        }),
      ),
    ).toThrowError(/unknown item/)
    expect(() =>
      validatePlanDraft(
        draft({
          items: [
            { id: 'a', phaseId: 'p1', title: 'A', description: '', dependsOn: ['b'] },
            { id: 'b', phaseId: 'p1', title: 'B', description: '', dependsOn: ['a'] },
          ],
        }),
      ),
    ).toThrowError(/cycle/)
  })
})

describe('applyPlanDraft', () => {
  it('folds a fresh draft in: items pending, status → awaiting_approval', () => {
    const next = applyPlanDraft(emptyEntity(), draft(), 100)
    expect(next.status).toBe('awaiting_approval')
    expect(next.items!.map((i) => i.status)).toEqual(['pending', 'pending'])
    expect(next.decisions![0]).toMatchObject({ title: 'A decision', at: 100, source: 'planning' })
  })

  it('preserves runtime state on a re-apply (replay/idempotent)', () => {
    const first = applyPlanDraft(emptyEntity(), draft(), 100)
    const executing: Initiative = {
      ...first,
      status: 'executing',
      items: first.items!.map((i) =>
        i.id === 'a'
          ? { ...i, status: 'done' as const, blockId: 'task-1', pr: { url: 'u', number: 1 } }
          : i,
      ),
    }
    // Re-applying the SAME draft must not reset the settled item or its PR link…
    const replayed = applyPlanDraft(executing, draft(), 200)
    expect(replayed.items!.find((i) => i.id === 'a')).toMatchObject({
      status: 'done',
      blockId: 'task-1',
      pr: { url: 'u', number: 1 },
    })
    // …must keep the original decision timestamp (byte-stable for the idempotency check)…
    expect(replayed.decisions![0]!.at).toBe(100)
    // …and must not regress an executing initiative back to awaiting_approval.
    expect(replayed.status).toBe('executing')
  })

  it('re-plan drops an omitted PENDING item but carries over a MATERIALISED one', () => {
    const first = applyPlanDraft(emptyEntity(), draft(), 100)
    const executing: Initiative = {
      ...first,
      status: 'executing',
      // 'a' is materialised (spawned + merged); 'b' is still pending/unspawned.
      items: first.items!.map((i) =>
        i.id === 'a'
          ? { ...i, status: 'done' as const, blockId: 'task-1', pr: { url: 'u', number: 1 } }
          : i,
      ),
    }

    // A re-plan that OMITS the still-pending 'b' genuinely drops it (kept only 'a').
    const dropsPending = applyPlanDraft(
      executing,
      draft({
        items: [{ id: 'a', phaseId: 'p1', title: 'Item A', description: '', dependsOn: [] }],
      }),
      300,
    )
    expect(dropsPending.items!.map((i) => i.id)).toEqual(['a'])

    // A re-plan that OMITS the materialised 'a' carries it over unchanged, so the spawned
    // task isn't orphaned and the merged PR/history survives.
    const keepsMaterialised = applyPlanDraft(
      executing,
      draft({
        items: [{ id: 'b', phaseId: 'p1', title: 'Item B', description: '', dependsOn: [] }],
      }),
      300,
    )
    expect(keepsMaterialised.items!.map((i) => i.id).sort()).toEqual(['a', 'b'])
    expect(keepsMaterialised.items!.find((i) => i.id === 'a')).toMatchObject({
      status: 'done',
      blockId: 'task-1',
      pr: { url: 'u', number: 1 },
    })
  })

  it('assigns deterministic slug ids when the draft omits them', () => {
    const next = applyPlanDraft(
      emptyEntity(),
      draft({
        phases: [{ title: 'Phase one', goal: '' }],
        items: [{ phaseId: 'p1', title: 'Some Item!', description: '', dependsOn: [] }],
      }),
      100,
    )
    expect(next.phases![0]!.id).toBe('phase-one')
    expect(next.items![0]!.id).toBe('some-item')
  })
})

describe('derivations', () => {
  it('derives the current phase (first with a non-terminal item) and the progress rollup', () => {
    const entity = applyPlanDraft(
      emptyEntity(),
      draft({
        phases: [
          { id: 'p1', title: 'One', goal: '' },
          { id: 'p2', title: 'Two', goal: '' },
        ],
        items: [
          { id: 'a', phaseId: 'p1', title: 'A', description: '', dependsOn: [] },
          { id: 'b', phaseId: 'p2', title: 'B', description: '', dependsOn: [] },
        ],
      }),
      1,
    )
    expect(deriveCurrentPhase(entity)?.id).toBe('p1')

    const p1Done: Initiative = {
      ...entity,
      items: entity.items!.map((i) => (i.id === 'a' ? { ...i, status: 'skipped' as const } : i)),
    }
    expect(deriveCurrentPhase(p1Done)?.id).toBe('p2')
    expect(initiativeProgress(p1Done)).toEqual({ done: 1, total: 2 })

    const allDone: Initiative = {
      ...p1Done,
      items: p1Done.items!.map((i) => ({ ...i, status: 'done' as const })),
    }
    expect(deriveCurrentPhase(allDone)).toBeNull()
  })

  it('slugifies titles safely', () => {
    expect(initiativeSlug('Migrate the API — v2!')).toBe('migrate-the-api-v2')
    expect(initiativeSlug('***')).toBe('initiative')
  })
})

describe('coerceInterviewOutput', () => {
  it('parses a questions round (done false, non-empty questions)', () => {
    const out = coerceInterviewOutput(
      { done: false, questions: ['What is the scope?', '  ', 'Any deadline?'] },
      { finalize: false },
    )
    expect(out).toEqual({ kind: 'questions', questions: ['What is the scope?', 'Any deadline?'] })
  })

  it('converges when done is true, carrying the synthesized brief', () => {
    const out = coerceInterviewOutput(
      {
        done: true,
        questions: [],
        goal: 'Migrate auth',
        constraints: ['no downtime'],
        nonGoals: ['x'],
      },
      { finalize: false },
    )
    expect(out).toEqual({
      kind: 'done',
      goal: 'Migrate auth',
      constraints: ['no downtime'],
      nonGoals: ['x'],
    })
  })

  it('converges when there are no questions even if done is absent', () => {
    expect(coerceInterviewOutput({ questions: [] }, { finalize: false }).kind).toBe('done')
  })

  it('finalize forces convergence regardless of returned questions', () => {
    const out = coerceInterviewOutput(
      { done: false, questions: ['still asking?'], goal: 'G' },
      { finalize: true },
    )
    expect(out).toEqual({ kind: 'done', goal: 'G', constraints: [], nonGoals: [] })
  })
})

describe('interview state transitions', () => {
  it('appends a round of pending questions and bumps the round', () => {
    let id = 0
    const next = applyInterviewQuestions(emptyEntity(), ['Q1', 'Q2'], () => `iqa-${++id}`)
    expect(next.qa).toEqual([
      { id: 'iqa-1', question: 'Q1', answer: '' },
      { id: 'iqa-2', question: 'Q2', answer: '' },
    ])
    expect(next.interview).toEqual({ round: 1, maxRounds: 4, status: 'awaiting' })
  })

  it('records an answer by question id', () => {
    let id = 0
    const asked = applyInterviewQuestions(emptyEntity(), ['Q1', 'Q2'], () => `iqa-${++id}`)
    const answered = applyInterviewAnswer(asked, 'iqa-1', 'Because reasons')
    expect(answered.qa?.find((q) => q.id === 'iqa-1')?.answer).toBe('Because reasons')
    expect(answered.qa?.find((q) => q.id === 'iqa-2')?.answer).toBe('')
  })

  it('a follow-up round keeps answered questions and drops skipped ones', () => {
    let id = 0
    const gen = () => `iqa-${++id}`
    const asked = applyInterviewQuestions(emptyEntity(), ['Q1', 'Q2'], gen)
    const answered = applyInterviewAnswer(asked, 'iqa-1', 'A1') // Q2 left unanswered (skipped)
    const round2 = applyInterviewQuestions(answered, ['Q3'], gen)
    expect(round2.qa?.map((q) => q.question)).toEqual(['Q1', 'Q3'])
    expect(round2.interview?.round).toBe(2)
  })

  it('outcome folds the brief, keeps only answered Q&A, and marks the interview done', () => {
    let id = 0
    const asked = applyInterviewQuestions(emptyEntity(), ['Q1', 'Q2'], () => `iqa-${++id}`)
    const answered = applyInterviewAnswer(asked, 'iqa-1', 'A1')
    const done = applyInterviewOutcome(answered, {
      goal: 'Ship it',
      constraints: ['keep runtimes symmetric'],
      nonGoals: ['backwards compat'],
    })
    expect(done.goal).toBe('Ship it')
    expect(done.constraints).toEqual(['keep runtimes symmetric'])
    expect(done.qa).toEqual([{ id: 'iqa-1', question: 'Q1', answer: 'A1' }])
    expect(done.interview?.status).toBe('done')
  })

  it('interviewAtCap is true once the round reaches maxRounds', () => {
    const base = emptyEntity()
    expect(interviewAtCap(base)).toBe(false)
    expect(
      interviewAtCap({ ...base, interview: { round: 3, maxRounds: 4, status: 'awaiting' } }),
    ).toBe(false)
    expect(
      interviewAtCap({ ...base, interview: { round: 4, maxRounds: 4, status: 'awaiting' } }),
    ).toBe(true)
  })

  it('applyAnalysis folds the analyst prose onto the entity', () => {
    expect(applyAnalysis(emptyEntity(), '  The codebase is layered.  ').analysisSummary).toBe(
      'The codebase is layered.',
    )
  })
})
