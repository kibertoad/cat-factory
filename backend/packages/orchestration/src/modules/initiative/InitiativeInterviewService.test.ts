import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { Block, Initiative, ModelProvider } from '@cat-factory/kernel'
import { clearRegisteredInitiativePresets, registerInitiativePreset } from '@cat-factory/kernel'
import { InitiativeInterviewService } from './InitiativeInterviewService.js'

// The interviewer runs a real `generateText` over the model the `ModelProvider` resolves; inject a
// deterministic `MockLanguageModelV3` (the AI SDK's own test double) that CAPTURES the prompt it is
// handed, so we can assert the T3 "build on the intake form, do NOT re-ask" steering appears ONLY
// when the preset FORM actually seeded qa — mirroring DocInterviewService.test.ts. `formSeeded`
// re-derives that from the real seeder over the registered preset, so these register real presets.

const MIGRATION_PRESET_ID = 'preset_migration'
/** A FULL-interview preset with two REQUIRED fields — a filled form seeds two qa exchanges. */
function registerMigrationPreset() {
  registerInitiativePreset({
    descriptor: {
      id: MIGRATION_PRESET_ID,
      presentation: {
        label: 'Technological migration',
        icon: 'i-lucide-database',
        color: '#000',
        description: 'Swap a load-bearing technology behind a safety net.',
      },
      fields: [
        { key: 'fromTech', label: 'From', type: 'text', required: true },
        { key: 'toTech', label: 'To', type: 'text', required: true },
      ],
      planningPipelineId: 'pl_initiative',
      interview: 'full',
      humanReviewDefault: true,
      defaultFragmentIds: [],
    },
  })
}

const STEERED_PRESET_ID = 'preset_steered_interviewer'
/** A phrase unique to this preset's interviewer promptAddition — never in the static system prompt. */
const INTERVIEWER_STEERING = 'probe the downtime tolerance and cutover window'
/**
 * A FULL-interview preset that registers an `initiative-interviewer` promptAddition. This is the
 * generic seam the migration preset (the first full-interview preset to steer its interviewer)
 * relies on: the inline interviewer must fold the registered steering into its prompt.
 */
function registerSteeredPreset() {
  registerInitiativePreset({
    descriptor: {
      id: STEERED_PRESET_ID,
      presentation: {
        label: 'Steered migration',
        icon: 'i-lucide-database',
        color: '#000',
        description: 'A full-interview preset that steers its interviewer.',
      },
      fields: [],
      planningPipelineId: 'pl_initiative',
      interview: 'full',
      humanReviewDefault: true,
      defaultFragmentIds: [],
    },
    promptAdditions: { 'initiative-interviewer': `Migration interview: ${INTERVIEWER_STEERING}.` },
  })
}

const OPTIONAL_PRESET_ID = 'preset_optional_only'
/**
 * A FULL-interview preset whose only field is OPTIONAL — so `{ notes: '' }` is a reachable frozen
 * `presetInputs` (validation allows a blank optional field, sanitize keeps the present empty value)
 * that seeds NO qa. This is the case the old `presetInputs`-cardinality gate got wrong.
 */
function registerOptionalOnlyPreset() {
  registerInitiativePreset({
    descriptor: {
      id: OPTIONAL_PRESET_ID,
      presentation: {
        label: 'Optional-only',
        icon: 'i-lucide-pencil',
        color: '#000',
        description: 'A preset whose fields are all optional.',
      },
      fields: [{ key: 'notes', label: 'Notes', type: 'textarea' }],
      planningPipelineId: 'pl_initiative',
      interview: 'full',
      humanReviewDefault: true,
      defaultFragmentIds: [],
    },
  })
}

function capturingModel() {
  let lastPrompt = ''
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      lastPrompt = JSON.stringify(options.prompt)
      return {
        content: [{ type: 'text', text: JSON.stringify({ done: false, questions: ['Q?'] }) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 40, text: 40, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
  return { model, prompt: () => lastPrompt }
}

const BLOCK = {
  id: 'blk_1',
  title: 'Migrate DB',
  type: 'task',
  description: 'Swap MSSQL for PostgreSQL.',
  modelId: undefined,
} as unknown as Block

function makeService(model: MockLanguageModelV3) {
  return new InitiativeInterviewService({
    modelProvider: { resolve: () => model } satisfies ModelProvider,
    modelRef: { provider: 'fake', model: 'm' },
  })
}

const initiative = (over: Partial<Initiative>): Initiative =>
  ({
    id: 'initv_1',
    blockId: BLOCK.id,
    slug: 's',
    title: 'Migrate DB',
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
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as Initiative

// A phrase unique to the T3 steering line — never present in the static system prompt.
const FORM_STEERING = 'intake-form responses'

describe('InitiativeInterviewService — build-on-form steering (T3)', () => {
  beforeEach(() => {
    clearRegisteredInitiativePresets()
    registerMigrationPreset()
    registerOptionalOnlyPreset()
  })
  afterEach(() => clearRegisteredInitiativePresets())

  it('tells the interviewer to build on the form when the initiative is form-backed', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview(
      'ws_1',
      BLOCK,
      initiative({
        presetId: MIGRATION_PRESET_ID,
        presetInputs: { fromTech: 'MSSQL', toTech: 'PostgreSQL 16' },
        qa: [
          { id: 'iqa-1', question: 'From', answer: 'MSSQL' },
          { id: 'iqa-2', question: 'To', answer: 'PostgreSQL 16' },
        ],
      }),
      { finalize: false },
    )
    expect(cap.prompt()).toContain(FORM_STEERING)
  })

  it('omits the steering for a preset-less initiative (no form seeded the qa)', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview(
      'ws_1',
      BLOCK,
      // An answered round exists, but no preset form backs this initiative.
      initiative({ qa: [{ id: 'iqa-1', question: 'Prior?', answer: 'A' }] }),
      { finalize: false },
    )
    expect(cap.prompt()).not.toContain(FORM_STEERING)
  })

  it('omits the steering for a full-interview preset with an empty form (preset_generic)', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview(
      'ws_1',
      BLOCK,
      // presetId set but no `presetInputs` (empty form), plus a prior answered round: the steering
      // must NOT appear, so preset_generic's interview stays byte-for-byte unchanged.
      initiative({
        presetId: 'preset_generic',
        qa: [{ id: 'iqa-1', question: 'Prior?', answer: 'A' }],
      }),
      { finalize: false },
    )
    expect(cap.prompt()).not.toContain(FORM_STEERING)
  })

  it('omits the steering when a form-backed preset seeded NO qa (all visible fields blank)', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview(
      'ws_1',
      BLOCK,
      // `presetInputs` is non-empty (the optional field was posted, present but blank), yet the form
      // seeded nothing — so the interviewer answers below are ALL interviewer-gathered, not form
      // facts. The gate must key off what the form actually seeded, not `presetInputs` cardinality,
      // or it would falsely tell the model those answers were "the intake-form responses".
      initiative({
        presetId: OPTIONAL_PRESET_ID,
        presetInputs: { notes: '' },
        qa: [{ id: 'iqa-1', question: 'Downtime tolerance?', answer: 'Zero' }],
      }),
      { finalize: false },
    )
    expect(cap.prompt()).not.toContain(FORM_STEERING)
  })
})

describe('InitiativeInterviewService — preset interviewer steering (T5)', () => {
  beforeEach(() => {
    clearRegisteredInitiativePresets()
    registerSteeredPreset()
    registerMigrationPreset()
  })
  afterEach(() => clearRegisteredInitiativePresets())

  it('folds the registered interviewer promptAddition into the prompt', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview(
      'ws_1',
      BLOCK,
      initiative({ presetId: STEERED_PRESET_ID }),
      { finalize: false },
    )
    expect(cap.prompt()).toContain(INTERVIEWER_STEERING)
    // Headed by the preset label so it reads the same way as the analyst/planner fold.
    expect(cap.prompt()).toContain('Steered migration')
  })

  it('leaves the prompt unchanged for a preset without an interviewer promptAddition', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview(
      'ws_1',
      BLOCK,
      // `registerMigrationPreset` sets a form but NO promptAdditions — so no steering appears.
      initiative({ presetId: MIGRATION_PRESET_ID }),
      { finalize: false },
    )
    expect(cap.prompt()).not.toContain(INTERVIEWER_STEERING)
    expect(cap.prompt()).not.toContain('Initiative preset:')
  })

  it('leaves the prompt unchanged for a preset-less initiative', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview('ws_1', BLOCK, initiative({}), { finalize: false })
    expect(cap.prompt()).not.toContain('Initiative preset:')
  })
})
