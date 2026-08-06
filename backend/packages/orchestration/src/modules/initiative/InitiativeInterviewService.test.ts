import { beforeEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { Block, Initiative, ModelProvider } from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { InitiativeInterviewService } from './InitiativeInterviewService.js'

// A fresh app-owned preset registry per test (reset + repopulated in each describe's `beforeEach`),
// injected into every service — the DI replacement for the old module-global register/clear.
let presetRegistry = new InitiativePresetRegistry()

// The interviewer runs a real `generateText` over the model the `ModelProvider` resolves; inject a
// deterministic `MockLanguageModelV3` (the AI SDK's own test double) that CAPTURES the prompt it is
// handed, so we can assert the T3 "build on the intake form, do NOT re-ask" steering appears ONLY
// when the preset FORM actually seeded qa — mirroring DocInterviewService.test.ts. `formSeeded`
// re-derives that from the real seeder over the registered preset, so these register real presets.

const MIGRATION_PRESET_ID = 'preset_migration'
/** A FULL-interview preset with two REQUIRED fields — a filled form seeds two qa exchanges. */
function registerMigrationPreset() {
  presetRegistry.register({
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
  presetRegistry.register({
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
  presetRegistry.register({
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
  let lastSystem = ''
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      lastPrompt = JSON.stringify(options.prompt)
      // `generateText`'s `system` reaches the model as the leading system message, so this is the
      // ROLE prompt as dispatched — asserted apart from the task prompt because the two halves make
      // different promises about the codebase analysis and must agree.
      lastSystem = JSON.stringify(
        options.prompt.filter((message) => message.role === 'system').map((m) => m.content),
      )
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
  return { model, prompt: () => lastPrompt, system: () => lastSystem }
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
    initiativePresetRegistry: presetRegistry,
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
    presetRegistry = new InitiativePresetRegistry()
    registerMigrationPreset()
    registerOptionalOnlyPreset()
  })

  it('tells the interviewer to build on the form when the initiative is form-backed', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview(
      'ws_1',
      BLOCK,
      initiative({
        presetId: MIGRATION_PRESET_ID,
        presetInputs: { fromTech: 'MSSQL', toTech: 'PostgreSQL 16' },
        qa: [
          { id: 'iqa-1', question: 'From', answer: 'MSSQL', status: 'open' },
          { id: 'iqa-2', question: 'To', answer: 'PostgreSQL 16', status: 'open' },
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
      initiative({ qa: [{ id: 'iqa-1', question: 'Prior?', answer: 'A', status: 'open' }] }),
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
        qa: [{ id: 'iqa-1', question: 'Prior?', answer: 'A', status: 'open' }],
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
        qa: [{ id: 'iqa-1', question: 'Downtime tolerance?', answer: 'Zero', status: 'open' }],
      }),
      { finalize: false },
    )
    expect(cap.prompt()).not.toContain(FORM_STEERING)
  })
})

describe('InitiativeInterviewService — preset interviewer steering (T5)', () => {
  beforeEach(() => {
    presetRegistry = new InitiativePresetRegistry()
    registerSteeredPreset()
    registerMigrationPreset()
  })

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

// ---------------------------------------------------------------------------
// Linked context (attached requirements / RFCs / PRDs / tracker issues).
//
// The interviewer is the FIRST planning step and the one that talks to the human, so it is the
// step where a missing attachment hurts most: without it the stakeholder is interrogated about
// exactly the facts the document they attached already settles. It is also the step the engine
// CANNOT feed automatically — it is inline and assembles its own prompt, never passing through
// `AgentContextBuilder` the way the analyst and planner that follow it do.
// ---------------------------------------------------------------------------

const PRD = {
  title: 'Auth migration PRD',
  url: 'https://example.test/prd',
  origin: 'confluence' as const,
  excerpt: 'Move every service onto the new auth model.',
  summary: 'Move every service onto the new auth model.',
  body: 'Sessions must stay valid across the cutover; no forced re-login.',
}

const LINKED_ISSUE = {
  key: 'ENG-42',
  url: 'https://example.test/ENG-42',
  title: 'Legacy tokens never expire',
  status: 'open',
  type: 'bug',
  assignee: null,
  priority: null,
  labels: [],
  description: 'Tokens minted before the rotation are accepted forever.',
  comments: [],
  summary: 'Tokens minted before the rotation are accepted forever.',
}

function serviceWithLinkedContext(
  model: MockLanguageModelV3,
  docs: (typeof PRD)[],
  tasks: (typeof LINKED_ISSUE)[],
  seen: { workspaceId?: string; blockId?: string; description?: string } = {},
) {
  return new InitiativeInterviewService({
    initiativePresetRegistry: presetRegistry,
    modelProvider: { resolve: () => model } satisfies ModelProvider,
    modelRef: { provider: 'fake', model: 'm' },
    resolveLinkedContext: async (workspaceId, blockId, description) => {
      seen.workspaceId = workspaceId
      seen.blockId = blockId
      seen.description = description
      return { docs, tasks }
    },
  })
}

describe('InitiativeInterviewService linked context', () => {
  beforeEach(() => {
    presetRegistry = new InitiativePresetRegistry()
  })

  it('injects the attached bodies inline, having no checkout to materialise them into', async () => {
    const cap = capturingModel()
    await serviceWithLinkedContext(cap.model, [PRD], [LINKED_ISSUE]).runInterview(
      'ws_1',
      BLOCK,
      initiative({}),
      { finalize: false },
    )
    // The interviewer is an INLINE call, so it gets the bodies themselves — a `.cat-context/`
    // pointer would name files that only a container run has on disk.
    expect(cap.prompt()).toContain('Sessions must stay valid across the cutover')
    expect(cap.prompt()).toContain('Tokens minted before the rotation are accepted forever.')
    expect(cap.prompt()).not.toContain('.cat-context')
  })

  it('tells the interviewer not to re-ask what the attachments already settle', async () => {
    const cap = capturingModel()
    await serviceWithLinkedContext(cap.model, [PRD], []).runInterview(
      'ws_1',
      BLOCK,
      initiative({}),
      { finalize: false },
    )
    // Without this instruction the model reads an attachment as background and still asks the
    // questions it answers — which is the interrogation attaching a PRD is meant to spare.
    expect(cap.prompt()).toContain('ALREADY ANSWERED')
  })

  it('resolves against the block and its brief, so a ref named in prose resolves too', async () => {
    const cap = capturingModel()
    const seen: { workspaceId?: string; blockId?: string; description?: string } = {}
    await serviceWithLinkedContext(cap.model, [], [], seen).runInterview(
      'ws_1',
      BLOCK,
      initiative({}),
      { finalize: false },
    )
    // The same three inputs `AgentContextBuilder` resolves with, so the interviewer can never see
    // a different set of attachments than the analyst and planner that follow it.
    expect(seen).toEqual({
      workspaceId: 'ws_1',
      blockId: BLOCK.id,
      description: BLOCK.description,
    })
  })

  it('grounds a recommended answer in the attachments', async () => {
    const cap = capturingModel()
    await serviceWithLinkedContext(cap.model, [PRD], []).recommendAnswer(
      'ws_1',
      BLOCK,
      initiative({}),
      'How should existing sessions be handled?',
    )
    expect(cap.prompt()).toContain('Sessions must stay valid across the cutover')
  })

  it('leaves both prompts unchanged when nothing is attached', async () => {
    const withNone = capturingModel()
    await serviceWithLinkedContext(withNone.model, [], []).runInterview(
      'ws_1',
      BLOCK,
      initiative({}),
      { finalize: false },
    )
    const unwired = capturingModel()
    // No resolver at all — a deployment with the documents/tasks integrations switched off.
    await makeService(unwired.model).runInterview('ws_1', BLOCK, initiative({}), {
      finalize: false,
    })
    expect(withNone.prompt()).toBe(unwired.prompt())
  })
})

// The codebase-analysis fold. `pl_initiative` runs the analyst BEFORE this gate precisely so the
// interviewer has a first-hand reading of the repository to interview AROUND — without it, an inline
// kind with no checkout can only ask the stakeholder to describe their own code, which is the
// interrogation the reorder exists to end. A run with no analysis (an unreachable repo, an
// analyst that produced nothing, the interviewer driven outside `pl_initiative`) must degrade to
// the previous, un-grounded prompt rather than claim an analysis it does not have.
describe('InitiativeInterviewService — codebase-analysis grounding', () => {
  const ANALYSIS = 'Auth lives in `services/auth`; sessions are signed JWTs with no refresh table.'
  /** A phrase unique to the analysis fold's steering — never in the static system prompt. */
  const ANALYSIS_STEERING = 'READ THE TARGET REPOSITORY'

  beforeEach(() => {
    presetRegistry = new InitiativePresetRegistry()
  })

  it('folds the analysis into the interview prompt and forbids re-asking what it settles', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview(
      'ws_1',
      BLOCK,
      initiative({ analysisSummary: ANALYSIS }),
      { finalize: false },
    )
    expect(cap.prompt()).toContain('## Codebase analysis')
    expect(cap.prompt()).toContain('no refresh table')
    expect(cap.prompt()).toContain(ANALYSIS_STEERING)
  })

  it('grounds a recommended answer in the analysis', async () => {
    const cap = capturingModel()
    await makeService(cap.model).recommendAnswer(
      'ws_1',
      BLOCK,
      initiative({ analysisSummary: ANALYSIS }),
      'How should existing sessions be handled?',
    )
    expect(cap.prompt()).toContain('no refresh table')
  })

  it('leaves both prompts unchanged when there is no analysis', async () => {
    // Whitespace-only is the shape a model that returned nothing usable lands in, so it must read
    // as absent rather than emitting an empty "## Codebase analysis" heading the model would then
    // treat as "the repository was read and holds nothing".
    for (const analysisSummary of ['', '   ']) {
      const cap = capturingModel()
      await makeService(cap.model).runInterview('ws_1', BLOCK, initiative({ analysisSummary }), {
        finalize: false,
      })
      expect(cap.prompt()).not.toContain('## Codebase analysis')
      expect(cap.prompt()).not.toContain(ANALYSIS_STEERING)
    }
  })
})

// The codebase-questions BAN is a rule about where an ANSWER comes from, so it is only true while
// the code has actually been read. Left absolute it would strand the degraded run — forbidden from
// asking about the code AND holding nothing that read it, strictly worse than before the analyst
// ever led. These pin that the ban and the fold move together: ONE predicate, so the role prompt
// can never claim a reading the task prompt does not carry.
describe('InitiativeInterviewService — the ban degrades with the fold', () => {
  const ANALYSIS = 'Auth lives in `services/auth`; sessions are signed JWTs.'
  /** The absolute prohibition — only defensible once the repository has been read. */
  const BAN = 'NEVER ask the stakeholder about the CURRENT STATE OF THE CODE'
  /** What replaces it: the interviewer is TOLD the repository is unread, and may ask about it. */
  const UNREAD = 'the repository has NOT been read'
  /** The interview's proper subject, stated in both variants. */
  const HUMAN_ONLY = 'risk and downtime tolerance'

  beforeEach(() => {
    presetRegistry = new InitiativePresetRegistry()
  })

  it('bans codebase questions when an analysis is in hand', async () => {
    const cap = capturingModel()
    await makeService(cap.model).runInterview(
      'ws_1',
      BLOCK,
      initiative({ analysisSummary: ANALYSIS }),
      { finalize: false },
    )
    expect(cap.system()).toContain(BAN)
    expect(cap.system()).not.toContain(UNREAD)
    expect(cap.system()).toContain(HUMAN_ONLY)
  })

  it('lifts the ban — and says why — when there is none', async () => {
    for (const analysisSummary of ['', '   ']) {
      const cap = capturingModel()
      await makeService(cap.model).runInterview('ws_1', BLOCK, initiative({ analysisSummary }), {
        finalize: false,
      })
      expect(cap.system()).not.toContain(BAN)
      expect(cap.system()).toContain(UNREAD)
      // Lifting the ban must not lose the priority: the human-only facts still come first.
      expect(cap.system()).toContain(HUMAN_ONLY)
    }
  })

  it('never promises the recommender an analysis it was not given', async () => {
    // A recommendation is adopted verbatim by a stakeholder, so a role prompt claiming a codebase
    // reading that never happened invites an invented answer wearing the platform's authority.
    const withAnalysis = capturingModel()
    await makeService(withAnalysis.model).recommendAnswer(
      'ws_1',
      BLOCK,
      initiative({ analysisSummary: ANALYSIS }),
      'How should existing sessions be handled?',
    )
    expect(withAnalysis.system()).toContain('a codebase analysis of the target repository')

    const without = capturingModel()
    await makeService(without.model).recommendAnswer(
      'ws_1',
      BLOCK,
      initiative({ analysisSummary: '' }),
      'How should existing sessions be handled?',
    )
    expect(without.system()).not.toContain('codebase analysis')
  })
})
