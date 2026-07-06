import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { Block, Initiative, ModelProvider } from '@cat-factory/kernel'
import { InitiativeInterviewService } from './InitiativeInterviewService.js'

// The interviewer runs a real `generateText` over the model the `ModelProvider` resolves; inject a
// deterministic `MockLanguageModelV3` (the AI SDK's own test double) that CAPTURES the prompt it is
// handed, so we can assert the T3 "build on the intake form, do NOT re-ask" steering appears ONLY
// for a FORM-backed initiative — mirroring DocInterviewService.test.ts.

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
  it('tells the interviewer to build on the form when the initiative is form-backed', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview(
      'ws_1',
      BLOCK,
      initiative({
        presetId: 'preset_migration',
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
})
