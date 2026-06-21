import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AgentConfigDescriptor } from '~/types/domain'
import { usePipelinesStore } from '~/stores/pipelines'

/**
 * The agent config-contribution catalog: the task-level parameters the registered
 * agent kinds surface (e.g. the Tester's environment). Static metadata hydrated from
 * the workspace snapshot. The task-creation form and inspector render the subset
 * whose owning agent kind appears in the task's selected pipeline.
 */
export const useAgentConfigStore = defineStore('agentConfig', () => {
  const descriptors = ref<AgentConfigDescriptor[]>([])

  function hydrate(list: AgentConfigDescriptor[]) {
    descriptors.value = [...list]
  }

  /** The descriptors contributed by the agent kinds of the given pipeline (by id). */
  function forPipeline(pipelineId: string | undefined): AgentConfigDescriptor[] {
    if (!pipelineId) return []
    const pipeline = usePipelinesStore().getPipeline(pipelineId)
    if (!pipeline) return []
    const kinds = new Set<string>(pipeline.agentKinds)
    return descriptors.value.filter((d) => kinds.has(d.agentKind))
  }

  /** The descriptors contributed across a set of agent kinds (by id). */
  function forKinds(kinds: Iterable<string>): AgentConfigDescriptor[] {
    const set = new Set(kinds)
    return descriptors.value.filter((d) => set.has(d.agentKind))
  }

  return { descriptors, hydrate, forPipeline, forKinds }
})
