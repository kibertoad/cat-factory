<script setup lang="ts">
import { ref } from 'vue'
import type { AgentKind } from '~/types/domain'
import { AGENT_BY_KIND } from '~/utils/catalog'
import AgentPalette from '~/components/palettes/AgentPalette.vue'

const pipelines = usePipelinesStore()
const agents = useAgentsStore()
const ui = useUiStore()

const open = computed({
  get: () => ui.builderOpen,
  set: (v: boolean) => (ui.builderOpen = v),
})

function add(kind: AgentKind) {
  pipelines.addToDraft(kind)
}

const toast = useToast()

// ---- "Add agent" mini-form -------------------------------------------------
const addAgentOpen = ref(false)
const newAgentName = ref('')
const newAgentDesc = ref('')

function openAddAgent() {
  newAgentName.value = ''
  newAgentDesc.value = ''
  addAgentOpen.value = true
}

function createAgent() {
  const agent = agents.addAgent({
    label: newAgentName.value,
    description: newAgentDesc.value,
  })
  toast.add({ title: `Added agent “${agent.label}”`, color: 'success', icon: 'i-lucide-check' })
  addAgentOpen.value = false
}

function placeholder(what: string) {
  toast.add({ title: 'Placeholder', description: what, icon: 'i-lucide-construction' })
}

async function save() {
  try {
    const saved = await pipelines.saveDraft()
    if (saved) {
      toast.add({ title: `Saved “${saved.name}”`, color: 'success', icon: 'i-lucide-check' })
      ui.builderOpen = false
    } else {
      toast.add({ title: 'Add at least one agent first', color: 'warning' })
    }
  } catch {
    toast.add({ title: 'Could not save pipeline', color: 'error' })
  }
}
</script>

<template>
  <USlideover v-model:open="open" title="Pipeline builder" side="left">
    <template #body>
      <div class="grid h-full grid-cols-2 gap-4">
        <!-- agent palette -->
        <div class="overflow-y-auto pr-1">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Agent palette
            </h3>
            <UButton
              color="primary"
              variant="soft"
              size="xs"
              icon="i-lucide-plus"
              @click="openAddAgent"
            >
              Add agent
            </UButton>
          </div>
          <AgentPalette @add="add" />
        </div>

        <!-- draft chain -->
        <div class="flex flex-col">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Pipeline
          </h3>
          <UInput
            v-model="pipelines.draftName"
            placeholder="Pipeline name"
            size="sm"
            class="mb-3"
          />

          <div
            v-if="pipelines.draft.length === 0"
            class="flex flex-1 items-center justify-center rounded-lg border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500"
          >
            Click agents on the left to assemble a linear pipeline.
          </div>

          <ol v-else class="flex-1 space-y-2 overflow-y-auto">
            <li
              v-for="(kind, i) in pipelines.draft"
              :key="i"
              class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 p-2"
            >
              <span class="w-4 text-center text-[10px] text-slate-500">{{ i + 1 }}</span>
              <UIcon
                :name="AGENT_BY_KIND[kind].icon"
                class="h-4 w-4"
                :style="{ color: AGENT_BY_KIND[kind].color }"
              />
              <span class="text-xs text-slate-100">{{ AGENT_BY_KIND[kind].label }}</span>
              <div class="ml-auto flex items-center">
                <!-- Approval gate: pause after this step so a human reviews (and
                     can edit) its proposal before the next step runs. -->
                <UButton
                  :icon="pipelines.draftGates[i] ? 'i-lucide-shield-check' : 'i-lucide-shield'"
                  :color="pipelines.draftGates[i] ? 'warning' : 'neutral'"
                  variant="ghost"
                  size="xs"
                  :title="
                    pipelines.draftGates[i]
                      ? 'Approval required after this step — click to remove the gate'
                      : 'Require human approval after this step'
                  "
                  @click="pipelines.toggleDraftGate(i)"
                />
                <UButton
                  icon="i-lucide-chevron-up"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :disabled="i === 0"
                  @click="pipelines.moveInDraft(i, i - 1)"
                />
                <UButton
                  icon="i-lucide-chevron-down"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :disabled="i === pipelines.draft.length - 1"
                  @click="pipelines.moveInDraft(i, i + 1)"
                />
                <UButton
                  icon="i-lucide-x"
                  color="error"
                  variant="ghost"
                  size="xs"
                  @click="pipelines.removeFromDraft(i)"
                />
              </div>
            </li>
          </ol>

          <!-- Saved pipelines: review the library + delete (the run affordance
               moved to the task card / inspector when the palettes were removed). -->
          <div v-if="pipelines.pipelines.length" class="mt-4 border-t border-slate-800 pt-3">
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Saved pipelines
            </h3>
            <ul class="space-y-1.5">
              <li
                v-for="p in pipelines.pipelines"
                :key="p.id"
                class="group flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/40 px-2 py-1.5"
              >
                <span class="flex-1 truncate text-xs text-slate-200">{{ p.name }}</span>
                <div class="flex items-center gap-0.5">
                  <template v-for="(k, i) in p.agentKinds" :key="i">
                    <UIcon
                      :name="AGENT_BY_KIND[k].icon"
                      class="h-3.5 w-3.5"
                      :style="{ color: AGENT_BY_KIND[k].color }"
                      :title="AGENT_BY_KIND[k].label"
                    />
                  </template>
                </div>
                <UButton
                  icon="i-lucide-trash-2"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="opacity-0 transition group-hover:opacity-100"
                  @click="pipelines.removePipeline(p.id)"
                />
              </li>
            </ul>
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between">
        <UButton color="neutral" variant="ghost" size="sm" @click="pipelines.clearDraft()">
          Clear
        </UButton>
        <UButton
          color="primary"
          icon="i-lucide-save"
          size="sm"
          :disabled="pipelines.draft.length === 0"
          @click="save"
        >
          Save pipeline
        </UButton>
      </div>
    </template>
  </USlideover>

  <!-- Add-agent form -->
  <UModal v-model:open="addAgentOpen" title="Add agent">
    <template #body>
      <div class="space-y-3">
        <div>
          <label
            class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            Name
          </label>
          <UInput
            v-model="newAgentName"
            placeholder="e.g. Security Auditor"
            size="sm"
            class="w-full"
          />
        </div>
        <div>
          <label
            class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            Description
          </label>
          <UTextarea
            v-model="newAgentDesc"
            :rows="2"
            autoresize
            size="sm"
            class="w-full"
            placeholder="What does this agent do?"
          />
        </div>
        <UButton
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-file-text"
          block
          @click="placeholder('Link context document')"
        >
          Link context document
        </UButton>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <UButton color="neutral" variant="ghost" size="sm" @click="addAgentOpen = false">
          Cancel
        </UButton>
        <UButton
          color="primary"
          icon="i-lucide-plus"
          size="sm"
          :disabled="!newAgentName.trim()"
          @click="createAgent"
        >
          Create agent
        </UButton>
      </div>
    </template>
  </UModal>
</template>
