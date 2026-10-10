import { describe, expect, it } from 'vitest'
import type { DocumentRecord, ModelProvider } from '@cat-factory/kernel'
import { DocumentPlannerService } from './DocumentPlannerService.js'
import { coerceTargetedPlan, planFromHeadings, type PlanTarget } from './documents.logic.js'

// The TARGET-AWARE half of planning: a plan authored for a service that already exists, which is
// what makes `spawn(frameId)` honest (a board-wide plan flattened into a frame discards the frame
// titles and types the preview rendered; a targeted one has nothing to discard). The LLM is a
// scripted fake — what is under test is the shape of the question and of the answer, not a model.

const TARGET: PlanTarget = {
  frameId: 'blk_frame',
  title: 'Storefront',
  type: 'frontend',
  existingModules: ['Cart'],
}

function record(partial: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    workspaceId: 'ws_1',
    source: 'figma',
    externalId: 'file123',
    title: 'Checkout redesign',
    url: 'https://www.figma.com/design/file123',
    body: '# Payment\n### Enter card\n# Review\n',
    excerpt: '',
    contentHash: 'h',
    syncedAt: 0,
    sourceVersion: null,
    linkedBlockId: null,
    role: null,
    docKind: null,
    ...partial,
  } as DocumentRecord
}

/** A model that answers with `text`, so the prompt it was handed can be asserted. */
function scriptedProvider(text: string, prompts: string[]): ModelProvider {
  return {
    resolve: () =>
      ({
        specificationVersion: 'v3',
        provider: 'fake',
        modelId: 'fake',
        supportedUrls: {},
        doStream: () => {
          throw new Error('the planner never streams')
        },
        doGenerate: async (options: { prompt: unknown }) => {
          prompts.push(JSON.stringify(options.prompt))
          return {
            content: [{ type: 'text', text }],
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          }
        },
      }) as never,
  } as unknown as ModelProvider
}

describe('the targeted heading fallback', () => {
  it('shifts the outline up: h1 is the target, h2 modules, h3 tasks', () => {
    const plan = planFromHeadings(
      'figma',
      'file123',
      'Checkout redesign',
      '# Checkout\n## Payment\n### Enter card\n## Review\n',
      TARGET,
    )
    expect(plan.targetFrameId).toBe('blk_frame')
    // The h1 is CONSUMED: keeping it would wrap everything in a module named after the document,
    // one level below the service that is already named after it.
    expect(plan.frames).toEqual([
      {
        type: 'frontend',
        title: 'Storefront',
        modules: [
          { name: 'Payment', tasks: [{ title: 'Enter card' }] },
          { name: 'Review', tasks: [] },
        ],
        tasks: [],
      },
    ])
  })

  it('closes the open module at an h1, so a later section is not folded into an earlier one', () => {
    const plan = planFromHeadings('figma', 'f', 'D', '## A\n# Next\n### Loose\n', TARGET)
    expect(plan.frames[0]?.modules.map((m) => m.name)).toEqual(['A'])
    expect(plan.frames[0]?.tasks).toEqual([{ title: 'Loose' }])
  })

  it('leaves a board-wide plan carrying no target, so the two are never confused', () => {
    expect(planFromHeadings('notion', 'p1', 'Spec', '# A\n').targetFrameId).toBeNull()
  })
})

describe('coerceTargetedPlan', () => {
  it('reads the targeted response shape onto the target frame', () => {
    const plan = coerceTargetedPlan(
      'figma',
      'file123',
      {
        modules: [{ name: 'Payment', tasks: [{ title: 'Card form' }] }],
        tasks: [{ title: 'Copy' }],
      },
      TARGET,
    )
    expect(plan).toEqual({
      source: 'figma',
      externalId: 'file123',
      planner: 'llm',
      targetFrameId: 'blk_frame',
      frames: [
        {
          type: 'frontend',
          title: 'Storefront',
          modules: [{ name: 'Payment', tasks: [{ title: 'Card form' }] }],
          tasks: [{ title: 'Copy' }],
        },
      ],
    })
  })

  it('refuses an ARCHITECTURE answer rather than re-reading its frames as modules', () => {
    // A targeted prompt answered with `frames` is a model proposing services where one already
    // exists. Laundering that into modules would put its mistake on the board silently; null
    // sends the caller to the targeted heading parser instead.
    expect(
      coerceTargetedPlan('figma', 'f', { frames: [{ title: 'Payments', modules: [] }] }, TARGET),
    ).toBeNull()
  })
})

describe('DocumentPlannerService.plan', () => {
  it('asks the targeted question, names the modules the frame already has, and folds design guidance in', async () => {
    const prompts: string[] = []
    const planner = new DocumentPlannerService({
      modelProvider: scriptedProvider(
        '{"modules":[{"name":"Payment","tasks":[]}],"tasks":[]}',
        prompts,
      ),
      modelRef: { provider: 'fake', model: 'fake' },
    })
    const plan = await planner.plan(record(), TARGET)

    const asked = prompts.join('')
    expect(asked).toContain('Existing service: Storefront')
    expect(asked).toContain('Modules it already has: Cart')
    // A design document describes screens, so the architecture question produces a service per
    // Figma page; the guidance is what redirects it to one task per screen or flow.
    expect(asked).toContain('one task per screen')
    expect(plan.targetFrameId).toBe('blk_frame')
    expect(plan.frames).toHaveLength(1)
  })

  it('does not fold design guidance into a prose document', async () => {
    const prompts: string[] = []
    const planner = new DocumentPlannerService({
      modelProvider: scriptedProvider('{"frames":[{"title":"Billing"}]}', prompts),
      modelRef: { provider: 'fake', model: 'fake' },
    })
    await planner.plan(record({ source: 'notion' }))
    expect(prompts.join('')).not.toContain('one task per screen')
  })

  it('degrades to the TARGETED fallback, never to a board-wide plan the caller did not ask for', async () => {
    const planner = new DocumentPlannerService({
      // Unparseable: the coercion answers null and the fallback decides the shape.
      modelProvider: scriptedProvider('not json at all', []),
      modelRef: { provider: 'fake', model: 'fake' },
    })
    const plan = await planner.plan(record(), TARGET)
    expect({
      planner: plan.planner,
      target: plan.targetFrameId,
      frames: plan.frames.length,
    }).toEqual({ planner: 'headings', target: 'blk_frame', frames: 1 })
  })
})
