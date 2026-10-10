import type { DescriptorField, ServiceConnection } from '@cat-factory/contracts'
import { matchServiceByName, serviceFramesOf } from '../assistant.logic.js'
import type { AssistantActionDefinition, AssistantActionOutcome } from '../types.js'
import { needsInput, performed } from '../types.js'
import type { AssistantBoardDeps } from './deps.js'
import { readArgument, resolveNamedService } from './shared.js'

// ---------------------------------------------------------------------------
// "Service A depends on service B": the assistant's route to the connection edge a service frame
// already carries (`service-connections.ts`), which is what makes both services spin up when a
// task on either is tested and what folds the relationship into the agents' prompts.
//
// The edge is stored on the CONSUMER, so which service is which is not a presentation detail: the
// two arguments are named `consumer` and `provider` and described to the model in terms of what
// depends on what, rather than as a first and second service it could fill in either order.
//
// Nothing here restates a board rule. A self-edge, a target that is not a service frame and a
// duplicate are all refused by `updateBlock`'s own validation, and they arrive at the SPA as the
// same 422 the inspector's picker would raise. The one thing this owns is IDEMPOTENCE: asking
// twice for an edge that exists is a request the board is already satisfying, so it reports the
// state rather than writing, and says which of the two happened.
// ---------------------------------------------------------------------------

const PARAMETERS: readonly DescriptorField[] = [
  {
    key: 'consumer',
    label: 'Consumer service',
    help: 'The name of the service that DEPENDS on the other one, the one whose work needs the other running.',
    required: true,
  },
  {
    key: 'provider',
    label: 'Provider service',
    help: 'The name of the service that is depended ON, and is spun up alongside the consumer when it is tested.',
    required: true,
  },
  {
    key: 'description',
    label: 'How it is used',
    help: 'Optional one-line description of how the consumer uses the provider, e.g. "sends transactional email via it".',
  },
]

export function declareServiceDependencyAction(
  deps: AssistantBoardDeps,
): AssistantActionDefinition {
  return {
    actionId: 'declare-service-dependency',
    purpose:
      'Record that one service on the board depends on another, so the provider is started ' +
      'alongside the consumer when the consumer is tested, and agents are told how it is used.',
    examples: [
      'the checkout service depends on the payments service for authorising cards',
      'make notifications a dependency of the orders service',
    ],
    parameters: PARAMETERS,
    async run({ workspaceId, arguments: args, editor }): Promise<AssistantActionOutcome> {
      const consumerName = readArgument(args, 'consumer')
      if (consumerName === undefined) return needsInput('missing_argument', 'consumer')
      const providerName = readArgument(args, 'provider')
      if (providerName === undefined) return needsInput('missing_argument', 'provider')

      // ONE board read for both ends: the two names are matched against the same snapshot, so a
      // frame renamed between them cannot make the pair resolve against two different boards.
      const frames = serviceFramesOf(await deps.listBoardBlocks(workspaceId))
      const consumer = resolveNamedService(matchServiceByName(frames, consumerName), 'consumer')
      if (consumer.kind !== 'one') return consumer.outcome
      const provider = resolveNamedService(matchServiceByName(frames, providerName), 'provider')
      if (provider.kind !== 'one') return provider.outcome

      const description = readArgument(args, 'description')
      const existing: ServiceConnection[] = consumer.frame.serviceConnections ?? []
      const declared = existing.find((edge) => edge.serviceBlockId === provider.frame.id)
      const ref = (frame: { id: string; title: string }) => ({
        blockId: frame.id,
        title: frame.title,
      })
      if (declared && (description === undefined || declared.description === description)) {
        // Already exactly as asked. Reported as a success that CREATED nothing rather than as a
        // conflict: the board is in the requested state, and a person who asked twice wants to
        // know that, not to be refused.
        return performed({
          actionId: 'declare-service-dependency',
          consumer: ref(consumer.frame),
          provider: ref(provider.frame),
          created: false,
        })
      }
      const edge: ServiceConnection = {
        serviceBlockId: provider.frame.id,
        ...(description === undefined ? {} : { description }),
      }
      const next = declared
        ? existing.map((entry) => (entry.serviceBlockId === provider.frame.id ? edge : entry))
        : [...existing, edge]
      const updated = await deps.updateBlock(
        workspaceId,
        consumer.frame.id,
        { serviceConnections: next },
        editor,
      )
      return performed({
        actionId: 'declare-service-dependency',
        consumer: { blockId: updated.id, title: updated.title },
        provider: ref(provider.frame),
        created: !declared,
      })
    },
  }
}
