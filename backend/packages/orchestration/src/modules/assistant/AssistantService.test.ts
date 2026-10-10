import type { Block, ModelProvider, ModelRef, ModelScope } from '@cat-factory/kernel'
import { CredentialRequiredError, RateLimitedError, UnavailableError } from '@cat-factory/kernel'
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

  it('lets a credential refusal through instead of reporting the model as broken', async () => {
    // The lease raises this from INSIDE the model call when the asker's personal password has not
    // been supplied, and it is the 428 the SPA branches on to open its password modal. Re-mapped
    // to the surface's 503 it becomes "the assistant model failed", which is both untrue and
    // unanswerable: the whole credential flow is unreachable behind it.
    const { action } = fakeAction()
    const refusing: ModelProvider = {
      resolve() {
        throw new CredentialRequiredError('enter your personal password', {
          vendor: 'claude',
          reason: 'password_required',
        })
      },
    }
    const service = new AssistantService({
      actions: [action],
      modelProvider: refusing,
      modelRef: { provider: 'openai', model: 'gpt-test' },
    })

    await expect(service.run(REQUEST)).rejects.toBeInstanceOf(CredentialRequiredError)
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

describe('AssistantService: the model a turn runs on', () => {
  /**
   * A turn under a workspace preset, with the refs each resolution step could produce kept
   * distinct so the one that WON is identifiable rather than inferred.
   */
  function servicePinning(over: {
    presetModelId: string
    pinnedForKind?: boolean
    catalog: Record<string, ModelRef>
    routingDefault: ModelRef
  }) {
    const asked: { agentKind?: string; modelId?: string } = {}
    // A reply that DECLINES: the routing decision is not what these cases are about, and a
    // decline reaches it through the same resolve-then-generate path an accepted one does.
    const { provider } = scriptedProvider('{"action":"none","arguments":{}}')
    const service = new AssistantService({
      actions: [fakeAction().action],
      modelProvider: provider,
      modelRef: over.routingDefault,
      resolveBlockModel: (modelId) => {
        asked.modelId = modelId
        return modelId ? over.catalog[modelId] : undefined
      },
      resolvePresetRouting: async (_workspaceId, agentKind) => {
        asked.agentKind = agentKind
        return { modelId: over.presetModelId, pinnedForKind: over.pinnedForKind ?? false }
      },
    })
    return { service, asked, provider }
  }

  const ROUTING_DEFAULT: ModelRef = { provider: 'openai', model: 'routing-default' }
  const BASE: ModelRef = { provider: 'openai', model: 'preset-base' }

  /**
   * A turn recording the credential SCOPE the provider was resolved for, which is the half the
   * model resolution above cannot see. Separate from `servicePinning` because the scope is
   * decided before any preset is read, and conflating them hid the omission for a release.
   */
  function serviceRecordingScope() {
    const scopes: ModelScope[] = []
    const { provider } = scriptedProvider('{"action":"none","arguments":{}}')
    const service = new AssistantService({
      actions: [fakeAction().action],
      modelProviderResolver: {
        forScope: async (scope) => {
          scopes.push(scope)
          return provider
        },
      },
      modelRef: { provider: 'openai', model: 'routing-default' },
    })
    return { service, scopes }
  }

  it('resolves the provider for the ASKER, not the workspace alone', async () => {
    // A turn has no run, so the asker is the only credential tier beyond the workspace it can
    // carry, and it is the one that decides whether a preset pinned to an individual-usage
    // subscription is reachable here at all. Dropped, the turn still answers: on the deployment's
    // routing default, billed to nobody, with only the model on the reply to say so.
    const { service, scopes } = serviceRecordingScope()

    await service.run(REQUEST)

    expect(scopes).toEqual([{ workspaceId: 'ws_1', userId: 'u_1' }])
  })

  it('claims only the workspace when no user is signed in', async () => {
    // An unauthenticated deployment. The narrower pool is a consequence of there being nobody to
    // name, which is a different fact from a caller that had a user and forgot it.
    const { service, scopes } = serviceRecordingScope()

    await service.run({ ...REQUEST, userId: null })

    expect(scopes).toEqual([{ workspaceId: 'ws_1' }])
  })

  it("runs on the workspace preset's BASE model, like every other kind that declares no override", async () => {
    // A preset states one base model for every agent kind, and the assistant is not special: it
    // pins no model of its own and selects no preset, so what it resolves is exactly what a
    // pipeline step under the same preset resolves. Falling through to the deployment's routing
    // default instead would put the assistant on a different model from everything the same
    // workspace runs, silently, and only the token bill would ever say so.
    const { service, asked } = servicePinning({
      presetModelId: 'preset-base',
      catalog: { 'preset-base': BASE },
      routingDefault: ROUTING_DEFAULT,
    })

    await service.run(REQUEST)

    expect(asked.agentKind).toBe('assistant')
    expect(asked.modelId).toBe('preset-base')
  })

  it("honours a preset override that NAMES the assistant, over that preset's base", async () => {
    // The other half of the same rule: an operator who pins a model for this kind gets it, which
    // is why the kind is listed in the Model Defaults panel rather than only inheriting.
    const { service, asked } = servicePinning({
      presetModelId: 'assistant-override',
      pinnedForKind: true,
      catalog: { 'assistant-override': { provider: 'openai', model: 'assistant-override' } },
      routingDefault: ROUTING_DEFAULT,
    })

    await service.run(REQUEST)

    expect(asked.modelId).toBe('assistant-override')
  })

  it('degrades to the routing default when the deployment cannot serve the preset model', async () => {
    // An empty catalog stands for a preset naming a model this deployment has no route to. The
    // turn still runs: a workspace preset naming a model the deployment cannot serve is a
    // configuration gap, not a reason to refuse a request the person just typed.
    const { service: pinned, asked } = servicePinning({
      presetModelId: 'unservable',
      catalog: {},
      routingDefault: ROUTING_DEFAULT,
    })

    expect((await pinned.run(REQUEST)).outcome.status).toBe('declined')
    expect(asked.modelId).toBe('unservable')
  })
})
