<script setup lang="ts">
// Workspace settings: the per-agent-kind default model overrides. For each agent
// kind you can pin which model its steps run on for this workspace; a kind left on
// "Deployment default" falls back to the env-configured routing. A model pinned on
// an individual task still wins over these. Persisted via the modelDefaults store
// (the backend replaces the whole map on each change).
import { ref } from 'vue'
import type { AgentKind } from '~/types/domain'
import { contextLabel, displayFlavor, isSelectable } from '~/stores/models'

const ui = useUiStore()
const models = useModelsStore()
const defaults = useModelDefaultsStore()
const agents = useAgentsStore()
const creds = useVendorCredentialsStore()
const workspace = useWorkspaceStore()
const toast = useToast()

const open = computed({
  get: () => ui.modelDefaultsOpen,
  set: (v: boolean) => (v ? ui.openModelDefaults() : ui.closeModelDefaults()),
})

const busy = ref<string | null>(null)

watch(open, (isOpen) => {
  if (isOpen) {
    void models.ensureLoaded(workspace.workspaceId ?? undefined)
    if (workspace.workspaceId) void creds.load(workspace.workspaceId)
  }
})

function modelLabel(id: string | undefined): string {
  // No pin → the deployment routing default. A pinned-but-uncatalogued id (e.g. a
  // model whose provider key was since removed) shows the raw id rather than
  // masquerading as "Deployment default", so the active state isn't misrepresented.
  if (!id) return 'Deployment default'
  const m = models.getModel(id)
  if (!m) return id
  const flavor = displayFlavor(m, creds.configuredVendors)
  return `${m.label} · ${flavor.providerLabel}`
}

function menuFor(kind: AgentKind) {
  const configured = creds.configuredVendors
  return [
    [
      {
        label: 'Deployment default',
        icon: 'i-lucide-rotate-ccw',
        onSelect: () => choose(kind, null),
      },
      ...models.models
        .filter((m) => isSelectable(m, configured))
        .map((m) => {
          const flavor = displayFlavor(m, configured)
          const ctx = contextLabel(flavor.contextTokens)
          const suffix = [flavor.providerLabel, ctx, flavor.quotaBased ? 'quota' : undefined]
            .filter(Boolean)
            .join(' · ')
          return {
            label: `${m.label} · ${suffix}`,
            icon: flavor.quotaBased ? 'i-lucide-infinity' : 'i-lucide-cpu',
            onSelect: () => choose(kind, m.id),
          }
        }),
    ],
  ]
}

async function choose(kind: AgentKind, modelId: string | null) {
  busy.value = kind
  try {
    await defaults.set(kind, modelId)
  } catch (e) {
    toast.add({
      title: 'Could not save default model',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Default models for agents" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-slate-400">
          Pin which model each agent kind runs on for this workspace — e.g. a strong reasoning model
          for the architect, a cheaper one for the documenter. A kind left on
          <span class="text-slate-300">Deployment default</span> uses the server's configured
          routing. A model pinned on an individual task still overrides these.
        </p>

        <p v-if="models.models.length === 0" class="px-1 py-4 text-center text-sm text-slate-500">
          Loading model catalog…
        </p>

        <div v-else class="divide-y divide-slate-800 rounded-lg border border-slate-800">
          <div
            v-for="a in agents.archetypes"
            :key="a.kind"
            class="flex items-center gap-3 px-3 py-2.5"
          >
            <UIcon :name="a.icon" class="h-4 w-4 shrink-0" :style="{ color: a.color }" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-slate-200">{{ a.label }}</p>
            </div>
            <span
              v-if="!defaults.forKind(a.kind)"
              class="hidden text-[11px] text-slate-500 sm:inline"
            >
              routing default
            </span>
            <UDropdownMenu :items="menuFor(a.kind)" :ui="{ content: 'max-h-72 overflow-y-auto' }">
              <UButton
                size="xs"
                :color="defaults.forKind(a.kind) ? 'primary' : 'neutral'"
                :variant="defaults.forKind(a.kind) ? 'subtle' : 'ghost'"
                trailing-icon="i-lucide-chevron-down"
                :loading="busy === a.kind"
              >
                {{ modelLabel(defaults.forKind(a.kind)) }}
              </UButton>
            </UDropdownMenu>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
