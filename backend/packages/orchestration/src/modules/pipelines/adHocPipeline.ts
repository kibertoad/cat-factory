import { ValidationError, type Pipeline } from '@cat-factory/kernel'
import { adHocPipelineIdFor, isPipelinePurpose } from '@cat-factory/contracts'
import type { AgentKindRegistry } from '@cat-factory/agents'

/**
 * Synthesize the one-step {@link Pipeline} a SINGLE-KIND run executes.
 *
 * Some agents are a whole job on their own: mapping a repository into the service blueprint,
 * drafting a stack recipe for the setup wizard. Each of those used to be a catalog pipeline with
 * exactly one step, which put an entry in the picker beside the build presets for something that
 * is not a pipeline in any sense a user would recognise — and made "run this agent once" a thing
 * the product could only offer by shipping another preset.
 *
 * The run is otherwise ORDINARY: the same admission gates, the same durable driver, the same
 * board projection, the same retry. Only the definition is ephemeral, which is why every rule
 * about what may run stays exactly where it was — a companion still has no producer to review, an
 * initiative kind still refuses a task block, and `validatePipelineShape` still says so.
 */
export function adHocPipelineFor(agentKind: string, registry: AgentKindRegistry): Pipeline {
  const definition = registry.get(agentKind)
  if (!definition) {
    throw new ValidationError(`Unknown agent kind '${agentKind}'.`, {
      reason: 'unknown_agent_kind',
      agentKind,
    })
  }
  const presentation = definition.presentation
  // The kind's OWN first declared purpose, when it declared any. A kind that declared none gets
  // `build`, the classifier every unclassified chain already falls into; the value only decides
  // which picker WOULD list it, and nothing lists a run with no pipeline behind it.
  const declared = presentation?.purposes?.find((p) => isPipelinePurpose(p))
  return {
    id: adHocPipelineIdFor(agentKind),
    name: presentation?.label ?? agentKind,
    agentKinds: [agentKind],
    purpose: declared ?? 'build',
  }
}
