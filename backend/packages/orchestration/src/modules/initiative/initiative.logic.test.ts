import type { Block, Initiative, InitiativePlanDraft } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  activeItemCount,
  allItemsSettled,
  applyAnalysis,
  applyDismissFollowUp,
  applyInterviewAnswer,
  applyInterviewOutcome,
  applyInterviewQuestions,
  applyItemEdit,
  applyPlanDraft,
  applyPolicyEdit,
  applyPromoteFollowUp,
  applyRevertClaim,
  applyRunHarvest,
  applySpawnClaim,
  assertInitiativeShapeAllowed,
  coerceInterviewOutput,
  deriveCurrentPhase,
  effectiveMaxConcurrent,
  eligibleItemsToSpawn,
  extractRunHarvest,
  harvestFollowUpId,
  initiativeProgress,
  initiativeSlug,
  interviewAtCap,
  itemDependenciesMet,
  phaseIsHalted,
  reconcileItem,
  selectInitiativePipeline,
  validatePlanDraft,
} from './initiative.logic.js'
import type {
  ExecutionInstance,
  InitiativeExecutionPolicy,
  InitiativeItem,
} from '@cat-factory/kernel'

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

// ---- Execution loop (slice 3) ---------------------------------------------

const item = (overrides: Partial<InitiativeItem> & Pick<InitiativeItem, 'id'>): InitiativeItem => ({
  phaseId: 'p1',
  title: `Item ${overrides.id}`,
  description: '',
  dependsOn: [],
  status: 'pending',
  ...overrides,
})

const executing = (overrides: Partial<Initiative> = {}): Initiative => ({
  ...emptyEntity(),
  status: 'executing',
  phases: [
    { id: 'p1', title: 'Phase one', goal: '' },
    { id: 'p2', title: 'Phase two', goal: '' },
  ],
  policy: {
    maxConcurrent: 2,
    rules: [],
    defaultPipelineId: 'pl_full',
    onMissingEstimate: 'default',
  },
  ...overrides,
})

const est = (complexity: number, risk: number, impact: number) => ({
  complexity,
  risk,
  impact,
  rationale: '',
})

const policy = (overrides: Partial<InitiativeExecutionPolicy> = {}): InitiativeExecutionPolicy => ({
  maxConcurrent: 2,
  rules: [],
  defaultPipelineId: 'pl_full',
  onMissingEstimate: 'default',
  ...overrides,
})

describe('selectInitiativePipeline', () => {
  it('honours an explicit per-item pipeline override', () => {
    expect(selectInitiativePipeline({ pipelineId: 'pl_custom' }, policy())).toBe('pl_custom')
  })

  it('falls back to the default when no rule matches', () => {
    const p = policy({ rules: [{ pipelineId: 'pl_heavy', minRisk: 0.8 }] })
    expect(selectInitiativePipeline({ estimate: est(0.9, 0.1, 0.1) }, p)).toBe('pl_full')
  })

  it('picks the FIRST rule whose ANY axis is met (OR across axes)', () => {
    const p = policy({
      rules: [
        { pipelineId: 'pl_mid', minComplexity: 0.5 },
        { pipelineId: 'pl_heavy', minRisk: 0.5 },
      ],
    })
    // risk clears the second rule, but complexity clears the first — first match wins.
    expect(selectInitiativePipeline({ estimate: est(0.6, 0.6, 0) }, p)).toBe('pl_mid')
    // only risk clears → second rule.
    expect(selectInitiativePipeline({ estimate: est(0.1, 0.6, 0) }, p)).toBe('pl_heavy')
  })

  it('applies onMissingEstimate for an item with no estimate', () => {
    const p = policy({
      rules: [{ pipelineId: 'pl_weak' }, { pipelineId: 'pl_strong', minRisk: 0.9 }],
    })
    expect(selectInitiativePipeline({}, p)).toBe('pl_full') // default
    expect(selectInitiativePipeline({}, policy({ ...p, onMissingEstimate: 'strongest' }))).toBe(
      'pl_strong',
    )
  })
})

describe('eligibleItemsToSpawn + phase sequencing', () => {
  it('returns pending items in the current phase whose deps are met', () => {
    const init = executing({
      items: [
        item({ id: 'a', status: 'done' }),
        item({ id: 'b', dependsOn: ['a'] }),
        item({ id: 'c', dependsOn: ['b'] }), // blocked by pending b
        item({ id: 'd', phaseId: 'p2' }), // later phase — not yet
      ],
    })
    expect(eligibleItemsToSpawn(init).map((i) => i.id)).toEqual(['b'])
  })

  it('halts the whole phase when it holds a blocked item (no new spawns)', () => {
    const init = executing({
      items: [item({ id: 'a', status: 'blocked' }), item({ id: 'b' })],
    })
    expect(phaseIsHalted(init, 'p1')).toBe(true)
    expect(eligibleItemsToSpawn(init)).toEqual([])
    // …and a blocked item keeps its phase current, so phase 2 never starts either.
    expect(deriveCurrentPhase(init)?.id).toBe('p1')
  })

  it('advances to the next phase only once the current phase fully settles', () => {
    const init = executing({
      items: [
        item({ id: 'a', status: 'done' }),
        item({ id: 'b', status: 'skipped' }),
        item({ id: 'c', phaseId: 'p2' }),
      ],
    })
    expect(deriveCurrentPhase(init)?.id).toBe('p2')
    expect(eligibleItemsToSpawn(init).map((i) => i.id)).toEqual(['c'])
  })

  it('respects a per-phase concurrency cap clamped by the policy cap', () => {
    const init = executing({
      phases: [{ id: 'p1', title: 'P1', goal: '', maxConcurrent: 1 }],
      policy: policy({ maxConcurrent: 3 }),
      items: [item({ id: 'a' })],
    })
    expect(effectiveMaxConcurrent(init, deriveCurrentPhase(init))).toBe(1)
  })

  it('counts only active (in_progress/pr_open) items against the cap', () => {
    const init = executing({
      items: [
        item({ id: 'a', status: 'in_progress' }),
        item({ id: 'b', status: 'pr_open' }),
        item({ id: 'c', status: 'done' }),
        item({ id: 'd' }),
      ],
    })
    expect(activeItemCount(init)).toBe(2)
  })

  it('treats a done/skipped dependency as satisfied and a pending one as not', () => {
    const init = executing({
      items: [item({ id: 'a', status: 'done' }), item({ id: 'b', status: 'skipped' })],
    })
    expect(itemDependenciesMet(init, item({ id: 'x', dependsOn: ['a', 'b'] }))).toBe(true)
    expect(itemDependenciesMet(init, item({ id: 'y', dependsOn: ['a', 'z-pending'] }))).toBe(true) // missing dep ⇒ satisfied
    const withPending = executing({ items: [item({ id: 'a' })] })
    expect(itemDependenciesMet(withPending, item({ id: 'y', dependsOn: ['a'] }))).toBe(false)
  })
})

describe('reconcileItem', () => {
  const spawned = item({ id: 'a', status: 'in_progress', blockId: 'blk-a' })

  it('maps a done block → done + copies the PR link', () => {
    const b = {
      ...block('task'),
      id: 'blk-a',
      status: 'done' as const,
      pullRequest: { url: 'u', number: 3 },
    }
    expect(reconcileItem(spawned, b)).toMatchObject({ status: 'done', pr: { url: 'u', number: 3 } })
  })

  it('maps a pr_ready block → pr_open', () => {
    const b = { ...block('task'), id: 'blk-a', status: 'pr_ready' as const }
    expect(reconcileItem(spawned, b).status).toBe('pr_open')
  })

  it('maps a blocked block → blocked + a note', () => {
    const b = { ...block('task'), id: 'blk-a', status: 'blocked' as const }
    const out = reconcileItem(spawned, b)
    expect(out.status).toBe('blocked')
    expect(out.note).toBeTruthy()
  })

  it('leaves a settled item untouched but reverts an orphaned active item to pending', () => {
    // A settled/non-active item is never touched, even with no block (replay-safe).
    expect(reconcileItem(item({ id: 'a', status: 'done' }), undefined)).toMatchObject({
      status: 'done',
    })
    // An ACTIVE item whose block vanished (crash between claim and insert, or a deleted block)
    // reverts to `pending` so the next spawn re-materialises it — it must not hold a slot forever.
    expect(reconcileItem(spawned, undefined)).toMatchObject({ status: 'pending', blockId: null })
  })
})

describe('spawn claim / revert + completion', () => {
  it('claims a pending item and is a no-op on an already-claimed one', () => {
    const init = executing({ items: [item({ id: 'a' })] })
    const claimed = applySpawnClaim(init, 'a', 'blk-new')
    expect(claimed.items![0]).toMatchObject({ status: 'in_progress', blockId: 'blk-new' })
    // A second claim (different block id) must NOT overwrite the winner's claim.
    const again = applySpawnClaim(claimed, 'a', 'blk-other')
    expect(again.items![0]!.blockId).toBe('blk-new')
  })

  it('reverts only a claim we own (matched by our block id)', () => {
    const init = executing({
      items: [item({ id: 'a', status: 'in_progress', blockId: 'blk-mine' })],
    })
    expect(applyRevertClaim(init, 'a', 'blk-mine').items![0]).toMatchObject({
      status: 'pending',
      blockId: null,
    })
    // A different block id (someone else's claim) is left alone.
    expect(applyRevertClaim(init, 'a', 'blk-theirs').items![0]!.status).toBe('in_progress')
  })

  it('allItemsSettled only when every item is done/skipped (empty ⇒ not settled)', () => {
    expect(allItemsSettled(executing({ items: [] }))).toBe(false)
    expect(
      allItemsSettled(
        executing({
          items: [item({ id: 'a', status: 'done' }), item({ id: 'b', status: 'skipped' })],
        }),
      ),
    ).toBe(true)
    expect(
      allItemsSettled(
        executing({
          items: [item({ id: 'a', status: 'done' }), item({ id: 'b', status: 'blocked' })],
        }),
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Follow-up harvest + human curation (slice 4)
// ---------------------------------------------------------------------------

/** An executing initiative with one phase and one in-flight item linked to a spawned block. */
const executingEntity = (): Initiative => ({
  ...emptyEntity(),
  status: 'executing',
  phases: [{ id: 'p1', title: 'Phase one', goal: '' }],
  items: [
    {
      id: 'a',
      phaseId: 'p1',
      title: 'Item A',
      description: 'do A',
      dependsOn: [],
      status: 'in_progress',
      blockId: 'blk-child-a',
    },
  ],
  policy: {
    maxConcurrent: 2,
    rules: [],
    defaultPipelineId: 'pl_full',
    onMissingEstimate: 'default',
  },
})

const runInstance = (overrides: Partial<ExecutionInstance> = {}): ExecutionInstance =>
  ({
    id: 'exec-1',
    blockId: 'blk-child-a',
    pipelineId: 'pl_full',
    pipelineName: 'Full build',
    currentStep: 0,
    status: 'done',
    steps: [
      {
        agentKind: 'coder',
        state: 'done',
        followUps: {
          enabled: true,
          items: [
            {
              id: 'fu-1',
              kind: 'follow_up',
              title: 'Extract shared helper',
              detail: 'the parser is duplicated',
              suggestedAction: 'move it to utils',
              status: 'pending',
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: 'q-1',
              kind: 'question',
              title: 'Which timezone?',
              detail: '',
              status: 'pending',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      },
    ],
    ...overrides,
  }) as unknown as ExecutionInstance

describe('extractRunHarvest', () => {
  it('lifts only follow_up-kind items (not questions) + the child block id', () => {
    const harvest = extractRunHarvest(runInstance())
    expect(harvest.childBlockId).toBe('blk-child-a')
    expect(harvest.followUps).toHaveLength(1)
    expect(harvest.followUps[0]).toMatchObject({ sourceId: 'fu-1', title: 'Extract shared helper' })
    expect(harvest.failure).toBeNull()
  })

  it('captures the failure cause on a failed run', () => {
    const harvest = extractRunHarvest(
      runInstance({
        status: 'failed',
        failure: {
          kind: 'agent',
          message: 'container crashed',
          detail: null,
          hint: null,
          occurredAt: 1,
          lastSubtasks: null,
        },
      }),
    )
    expect(harvest.failure).toEqual({ kind: 'agent', detail: 'container crashed' })
  })
})

describe('applyRunHarvest', () => {
  it('folds follow-ups as open entries linked to the source item, and is idempotent', () => {
    const entity = executingEntity()
    const harvest = extractRunHarvest(runInstance())
    const once = applyRunHarvest(entity, harvest, 100)
    expect(once.followUps).toHaveLength(1)
    expect(once.followUps![0]).toMatchObject({
      id: harvestFollowUpId('blk-child-a', 'fu-1'),
      sourceItemId: 'a',
      status: 'open',
      title: 'Extract shared helper',
    })
    // Suggested action is folded into the detail.
    expect(once.followUps![0]!.detail).toContain('move it to utils')
    // Re-harvesting the same run adds nothing (stable id) and returns the input unchanged.
    expect(applyRunHarvest(once, harvest, 200)).toBe(once)
  })

  it('stamps the failing item note with the real cause (the deviation reads it)', () => {
    const entity = executingEntity()
    const harvest = extractRunHarvest(
      runInstance({
        status: 'failed',
        failure: {
          kind: 'agent',
          message: 'tests failed',
          detail: null,
          hint: null,
          occurredAt: 1,
          lastSubtasks: null,
        },
      }),
    )
    const next = applyRunHarvest(entity, harvest, 100)
    expect(next.items![0]!.note).toContain('tests failed')
  })
})

describe('applyPromoteFollowUp', () => {
  const seeded = (): Initiative =>
    applyRunHarvest(executingEntity(), extractRunHarvest(runInstance()), 100)
  const fuId = harvestFollowUpId('blk-child-a', 'fu-1')

  it('creates a new pending item and marks the follow-up promoted', () => {
    const next = applyPromoteFollowUp(seeded(), fuId, { phaseId: 'p1' })
    const promoted = next.followUps!.find((f) => f.id === fuId)!
    expect(promoted.status).toBe('promoted')
    const newItem = next.items!.find((i) => i.id === promoted.promotedItemId)!
    expect(newItem).toMatchObject({
      phaseId: 'p1',
      status: 'pending',
      title: 'Extract shared helper',
    })
  })

  it('honours a title/description/phase override', () => {
    const next = applyPromoteFollowUp(seeded(), fuId, {
      phaseId: 'p1',
      title: 'Custom',
      description: 'custom desc',
    })
    const newItem = next.items!.find((i) => i.title === 'Custom')!
    expect(newItem.description).toBe('custom desc')
  })

  it('rejects an unknown phase', () => {
    expect(() => applyPromoteFollowUp(seeded(), fuId, { phaseId: 'nope' })).toThrowError(/phase/)
  })

  it('is a no-op on an already-settled follow-up', () => {
    const promoted = applyPromoteFollowUp(seeded(), fuId, { phaseId: 'p1' })
    expect(applyPromoteFollowUp(promoted, fuId, { phaseId: 'p1' })).toBe(promoted)
  })
})

describe('applyDismissFollowUp', () => {
  it('marks an open follow-up dismissed and no-ops thereafter', () => {
    const seeded = applyRunHarvest(executingEntity(), extractRunHarvest(runInstance()), 100)
    const fuId = harvestFollowUpId('blk-child-a', 'fu-1')
    const next = applyDismissFollowUp(seeded, fuId)
    expect(next.followUps!.find((f) => f.id === fuId)!.status).toBe('dismissed')
    expect(applyDismissFollowUp(next, fuId)).toBe(next)
  })
})

describe('applyItemEdit', () => {
  const blockedEntity = (): Initiative => ({
    ...executingEntity(),
    items: [
      {
        id: 'a',
        phaseId: 'p1',
        title: 'Item A',
        description: 'do A',
        dependsOn: [],
        status: 'blocked',
        note: 'boom',
        blockId: null,
      },
    ],
  })

  it('retries a blocked item back to pending, clearing its note + link', () => {
    const next = applyItemEdit(blockedEntity(), 'a', { action: 'retry' })
    expect(next.items![0]).toMatchObject({ status: 'pending', note: undefined, blockId: null })
  })

  it('skips a blocked item', () => {
    expect(applyItemEdit(blockedEntity(), 'a', { action: 'skip' }).items![0]!.status).toBe(
      'skipped',
    )
  })

  it('edits content of a pending/blocked item', () => {
    const next = applyItemEdit(blockedEntity(), 'a', { title: 'Renamed', description: 'new' })
    expect(next.items![0]).toMatchObject({ title: 'Renamed', description: 'new' })
  })

  it('refuses to edit an in-flight item', () => {
    expect(() => applyItemEdit(executingEntity(), 'a', { title: 'X' })).toThrowError(/in_progress/)
  })

  it('refuses retry on a non-blocked item', () => {
    expect(() => applyItemEdit(executingEntity(), 'a', { action: 'retry' })).toThrowError(/blocked/)
  })

  it('rejects an unknown item and a self/unknown dependency', () => {
    expect(() => applyItemEdit(blockedEntity(), 'zzz', {})).toThrowError(/Unknown item/)
    expect(() => applyItemEdit(blockedEntity(), 'a', { dependsOn: ['a'] })).toThrowError(/itself/)
    expect(() => applyItemEdit(blockedEntity(), 'a', { dependsOn: ['ghost'] })).toThrowError(
      /unknown item/,
    )
  })

  it('rejects a re-scoped dependency that would introduce a cycle', () => {
    // Two pending items where b already depends on a; editing a to depend on b closes the loop.
    const twoItems: Initiative = {
      ...executingEntity(),
      items: [
        { id: 'a', phaseId: 'p1', title: 'A', description: '', dependsOn: [], status: 'pending' },
        {
          id: 'b',
          phaseId: 'p1',
          title: 'B',
          description: '',
          dependsOn: ['a'],
          status: 'pending',
        },
      ],
    }
    expect(() => applyItemEdit(twoItems, 'a', { dependsOn: ['b'] })).toThrowError(/cycle/)
  })

  it('refuses to curate an item on a non-executing initiative', () => {
    const done: Initiative = { ...blockedEntity(), status: 'done' }
    expect(() => applyItemEdit(done, 'a', { action: 'retry' })).toThrowError(/executing/)
  })
})

describe('applyPolicyEdit', () => {
  const policy: InitiativeExecutionPolicy = {
    maxConcurrent: 5,
    rules: [],
    defaultPipelineId: 'pl_quick',
    onMissingEstimate: 'default',
  }

  it('replaces the policy', () => {
    expect(applyPolicyEdit(executingEntity(), policy).policy).toEqual(policy)
  })

  it('refuses to edit the policy of a non-executing initiative', () => {
    expect(() => applyPolicyEdit({ ...executingEntity(), status: 'paused' }, policy)).toThrowError(
      /executing/,
    )
  })
})

describe('curation status guard', () => {
  const fuId = harvestFollowUpId('blk-child-a', 'fu-1')
  // Harvest itself is loop-driven and unguarded, so seed a follow-up then settle the initiative;
  // the human triage transforms are the ones gated on `executing`.
  const settled: Initiative = {
    ...applyRunHarvest(executingEntity(), extractRunHarvest(runInstance()), 1),
    status: 'cancelled',
  }

  it('refuses promote/dismiss once the initiative is no longer executing', () => {
    expect(() => applyPromoteFollowUp(settled, fuId, { phaseId: 'p1' })).toThrowError(/executing/)
    expect(() => applyDismissFollowUp(settled, fuId)).toThrowError(/executing/)
  })
})
