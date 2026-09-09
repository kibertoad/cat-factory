import type { Block, ModelProvider, ModelRef } from '@cat-factory/kernel'
import { RateLimitedError, UnavailableError } from '@cat-factory/kernel'
import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { AssistantService } from './AssistantService.js'
import type { AssistantActionDefinition } from './types.js'
import { needsInput, performed } from './types.js'

// What this covers: everything between the model's reply and the side effect. The three built-in
// ACTIONS are exercised through their own suite; here the actions are fakes, so what is under test
// is the routing itself: the parse, the catalog lookup, the argument validation, the budget
// guard, and the two ways a turn ends without acting.
//
// Every one of those is a place a wrong answer would be SILENT rather than loud: a hallucinated
// action id that ran the nearest real one, an invented argument key that failed the whole turn, a
// reply the model wrote into its reasoning channel reported as "no, I won't do that".

/** A provider whose model replies with one scripted text, recording what it was asked. */
function scriptedProvider(text: string): { provider: ModelProvider; prompts: string[] } {
  const prompts: string[] = []
  const provider: ModelProvider = {
    resolve(_ref: ModelRef): ReturnType<ModelProvider['resolve']> {
      return new MockLanguageModelV3({
        doGenerate: async (options) => {
          prompts.push(JSON.stringify(options.prompt))
          return {
            content: [{ type: 'text' as const, text }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          }
        },
      }) as unknown as ReturnType<ModelProvider['resolve']>
    },
  }
  return { provider, prompts }
}

const SERVICE_REF: Block = {
  id: 'f1',
  title: 'Payments',
  type: 'service',
  description: '',
  position: { x: 0, y: 0 },
  status: 'planned',
  progress: 0,
  dependsOn: [],
  executionId: null,
  level: 'frame',
  parentId: null,
}

/** A stand-in action that records the bag it was handed and reports a fixed outcome. */
function fakeAction(over: Partial<AssistantActionDefinition> = {}): {
  action: AssistantActionDefinition
  seen: Record<string, unknown>[]
} {
  const seen: Record<string, unknown>[] = []
  const action: AssistantActionDefinition = {
    actionId: 'declare-service-dependency',
    purpose: 'Record that one service depends on another.',
    examples: ['checkout depends on payments'],
    parameters: [
      { key: 'consumer', label: 'Consumer', help: 'The dependent service.', required: true },
      { key: 'directory', label: 'Directory', type: 'path' },
    ],
    async run(context) {
      seen.push(context.arguments)
      return performed({
        actionId: 'declare-service-dependency',
        consumer: { blockId: SERVICE_REF.id, title: SERVICE_REF.title },
        provider: { blockId: 'f2', title: 'Ledger' },
        created: true,
      })
    },
    ...over,
  }
  return { action, seen }
}

function serviceWith(
  text: string,
  actions: AssistantActionDefinition[],
  over: { isOverBudget?: () => Promise<boolean> } = {},
) {
  const { provider, prompts } = scriptedProvider(text)
  const service = new AssistantService({
    actions,
    modelProvider: provider,
    modelRef: { provider: 'openai', model: 'gpt-test' },
    ...(over.isOverBudget ? { isOverBudget: over.isOverBudget } : {}),
  })
  return { service, prompts }
}

const REQUEST = {
  workspaceId: 'ws_1',
  input: { kind: 'prompt', prompt: 'checkout depends on payments' },
  editor: UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
  userId: 'u_1',
} as const

/** The same request, answering a question a previous turn asked instead of typing a sentence. */
function answering(args: Record<string, string>) {
  return {
    ...REQUEST,
    input: {
      kind: 'answer',
      answer: { actionId: 'declare-service-dependency', arguments: args },
    },
  } as const
}

describe('AssistantService.capability', () => {
  it('reports the wired model and the catalog it can route to', () => {
    const { action } = fakeAction()
    const { service } = serviceWith('{}', [action])
    expect(service.capability()).toEqual({
      available: true,
      actions: ['declare-service-dependency'],
    })
  })

  it('reports unavailable when no provider is wired', () => {
    const { action } = fakeAction()
    expect(new AssistantService({ actions: [action] }).capability().available).toBe(false)
  })
})

describe('AssistantService.run', () => {
  it('performs the action the model named, with the arguments it copied', async () => {
    const { action, seen } = fakeAction()
    const { service, prompts } = serviceWith(
      '{"action":"declare-service-dependency","arguments":{"consumer":"Checkout"}}',
      [action],
    )
    const turn = await service.run(REQUEST)
    expect(turn.outcome).toEqual({
      status: 'performed',
      result: {
        actionId: 'declare-service-dependency',
        consumer: { blockId: 'f1', title: 'Payments' },
        provider: { blockId: 'f2', title: 'Ledger' },
        created: true,
      },
    })
    expect(turn.model).toEqual({ provider: 'openai', model: 'gpt-test' })
    expect(seen).toEqual([{ consumer: 'Checkout' }])
    // The person's words reach the model inside the delimited request, not as instructions.
    expect(prompts[0]).toContain('checkout depends on payments')
  })

  it('declines when the model says nothing fits', async () => {
    const { action, seen } = fakeAction()
    const { service } = serviceWith('{"action":"none","arguments":{}}', [action])
    expect((await service.run(REQUEST)).outcome).toEqual({
      status: 'declined',
      reason: 'no_matching_action',
    })
    expect(seen).toEqual([])
  })

  it('declines an action id outside the catalog rather than running the nearest one', async () => {
    const { action, seen } = fakeAction()
    const { service } = serviceWith('{"action":"delete-everything","arguments":{}}', [action])
    expect((await service.run(REQUEST)).outcome).toEqual({
      status: 'declined',
      reason: 'no_matching_action',
    })
    expect(seen).toEqual([])
  })

  it('passes an action’s own clarification through, naming the action it was heading for', async () => {
    const { action } = fakeAction({
      run: async () => needsInput('ambiguous_service', 'consumer', ['Payments API', 'API Gateway']),
    })
    const { service } = serviceWith(
      '{"action":"declare-service-dependency","arguments":{"consumer":"api"}}',
      [action],
    )
    expect((await service.run(REQUEST)).outcome).toEqual({
      status: 'needs_input',
      actionId: 'declare-service-dependency',
      reason: 'ambiguous_service',
      field: 'consumer',
      candidates: ['Payments API', 'API Gateway'],
      // The arguments ride along, because they are what makes the question ANSWERABLE: the next
      // turn re-runs this action with `consumer` replaced and everything else carried over.
      arguments: { consumer: 'api' },
    })
  })

  it('refuses an argument value the shared descriptor rules reject, naming the field', async () => {
    const { action, seen } = fakeAction()
    const { service } = serviceWith(
      '{"action":"declare-service-dependency","arguments":{"consumer":"A","directory":"../../etc"}}',
      [action],
    )
    expect((await service.run(REQUEST)).outcome).toEqual({
      status: 'needs_input',
      actionId: 'declare-service-dependency',
      reason: 'invalid_argument',
      field: 'directory',
      candidates: [],
      arguments: { consumer: 'A', directory: '../../etc' },
    })
    expect(seen).toEqual([])
  })

  it('reads a decision out of a fenced reply', async () => {
    const { action, seen } = fakeAction()
    const { service } = serviceWith(
      'Sure!\n```json\n{"action":"declare-service-dependency","arguments":{"consumer":"Checkout"}}\n```',
      [action],
    )
    expect((await service.run(REQUEST)).outcome.status).toBe('performed')
    expect(seen).toEqual([{ consumer: 'Checkout' }])
  })

  it('refuses a reply that carries no decision rather than reading it as a decline', async () => {
    const { action } = fakeAction()
    const { service } = serviceWith('', [action])
    await expect(service.run(REQUEST)).rejects.toBeInstanceOf(UnavailableError)
  })

  it('refuses fail-closed when the workspace has spent its budget', async () => {
    const { action, seen } = fakeAction()
    const { service, prompts } = serviceWith(
      '{"action":"declare-service-dependency","arguments":{"consumer":"Checkout"}}',
      [action],
      { isOverBudget: async () => true },
    )
    await expect(service.run(REQUEST)).rejects.toBeInstanceOf(RateLimitedError)
    expect(prompts).toEqual([])
    expect(seen).toEqual([])
  })

  it('refuses when no model is configured, before anything is asked of an action', async () => {
    const { action, seen } = fakeAction()
    await expect(new AssistantService({ actions: [action] }).run(REQUEST)).rejects.toBeInstanceOf(
      UnavailableError,
    )
    expect(seen).toEqual([])
  })

  it('refuses when the deployment registered no actions at all', async () => {
    const { service } = serviceWith('{}', [])
    await expect(service.run(REQUEST)).rejects.toBeInstanceOf(UnavailableError)
  })
})

describe('AssistantService.run — answering a clarification', () => {
  it('performs the named action with the supplied arguments, reaching no model at all', async () => {
    const { action, seen } = fakeAction()
    const { service, prompts } = serviceWith('{"action":"none","arguments":{}}', [action])
    const turn = await service.run(answering({ consumer: 'Payments API' }))
    expect(turn.outcome.status).toBe('performed')
    expect(seen).toEqual([{ consumer: 'Payments API' }])
    // The whole point: no vendor call, so a question the platform asked costs nothing to answer
    // and cannot re-route to a different action on the way back.
    expect(prompts).toEqual([])
    // And nothing to attribute: reporting the previous turn's model would name a call that this
    // turn never made.
    expect(turn.model).toBeNull()
  })

  it('is not billable, so it runs even when the workspace is over budget', async () => {
    const { action, seen } = fakeAction()
    const { service } = serviceWith('{}', [action], { isOverBudget: async () => true })
    expect((await service.run(answering({ consumer: 'Payments API' }))).outcome.status).toBe(
      'performed',
    )
    expect(seen).toEqual([{ consumer: 'Payments API' }])
  })

  it('holds an answer to the SAME rules a routed turn passes, dropping undeclared keys', async () => {
    const { action, seen } = fakeAction()
    const { service } = serviceWith('{}', [action])
    await service.run(answering({ consumer: 'Payments API', sudo: 'yes' }))
    // `sudo` is not a declared parameter, so it never reaches the action: an answer is not a way
    // past the validation a model's own reply goes through.
    expect(seen).toEqual([{ consumer: 'Payments API' }])
  })

  it('refuses an answer whose value the descriptor rules reject, exactly as a routed turn does', async () => {
    const { action, seen } = fakeAction()
    const { service } = serviceWith('{}', [action])
    expect(
      (await service.run(answering({ consumer: 'A', directory: '../../etc' }))).outcome,
    ).toMatchObject({ status: 'needs_input', reason: 'invalid_argument', field: 'directory' })
    expect(seen).toEqual([])
  })

  it('declines when the answered action is no longer in the catalog', async () => {
    // The deployment unwired the integration between the question and its answer.
    const { service } = serviceWith('{}', [fakeAction().action])
    const request = {
      ...REQUEST,
      input: {
        kind: 'answer',
        answer: { actionId: 'add-service-from-repo', arguments: { repoUrl: 'acme/payments' } },
      },
    } as const
    expect((await service.run(request)).outcome).toEqual({
      status: 'declined',
      reason: 'no_matching_action',
    })
  })
})
