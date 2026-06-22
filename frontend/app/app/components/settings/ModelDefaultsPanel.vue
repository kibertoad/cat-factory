<script setup lang="ts">
// Workspace settings: the per-agent-kind default model overrides. For each agent
// kind you can pin which model its steps run on for this workspace; a kind left on
// the deployment default falls back to the env-configured routing (named here so
// you can see which model that actually is). A model pinned on an individual task
// still wins over these. Persisted via the modelDefaults store (the backend
// replaces the whole map on each change).
//
// Styled as a dark full-screen window like the agent-output review overlay
// (AgentStepDetail) rather than a light modal, so the text stays readable
// regardless of the OS colour-mode preference.
import { ref, computed, watch } from 'vue'
import { onKeyStroke } from '@vueuse/core'
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
// Narrows which models appear in every kind's picker, for finding one fast.
const filter = ref('')

watch(open, (isOpen) => {
  if (isOpen) {
    filter.value = ''
    void models.ensureLoaded()
    if (workspace.workspaceId) void creds.load(workspace.workspaceId)
  }
})

onKeyStroke('Escape', () => {
  if (open.value) open.value = false
})

/** The label shown on a kind's button: its pinned model, else the named deployment default. */
function buttonLabel(kind: AgentKind): string {
  const pinned = defaults.forKind(kind)
  if (pinned) {
    const m = models.getModel(pinned)
    // A pinned-but-uncatalogued id (e.g. a model whose provider key was since
    // removed) shows the raw id rather than masquerading as a default.
    if (!m) return pinned
    return `${m.label} · ${displayFlavor(m, creds.configuredVendors).providerLabel}`
  }
  // No pin → name the env-routing model this kind actually falls back to.
  const ref = defaults.deploymentRefForKind(kind)
  const label = ref ? models.labelForRef(ref) : undefined
  return label ? `${label} (default)` : 'Deployment default'
}

function menuFor(kind: AgentKind) {
  const configured = creds.configuredVendors
  const q = filter.value.trim().toLowerCase()
  const matches = (label: string, provider: string, model: string) =>
    !q ||
    label.toLowerCase().includes(q) ||
    provider.toLowerCase().includes(q) ||
    model.toLowerCase().includes(q)
  return [
    [
      {
        label: 'Deployment default',
        icon: 'i-lucide-rotate-ccw',
        onSelect: () => choose(kind, null),
      },
      ...models.models
        .filter((m) => isSelectable(m, configured))
        .map((m) => ({ m, flavor: displayFlavor(m, configured) }))
        .filter(({ m, flavor }) => matches(m.label, flavor.providerLabel, flavor.model))
        .map(({ m, flavor }) => {
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
  <Teleport to="body">
    <Transition name="reader-fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex flex-col bg-slate-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15"
          >
            <UIcon name="i-lucide-cpu" class="h-5 w-5 text-indigo-300" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-white">Default models for agents</h1>
            <p class="truncate text-xs text-slate-500">
              Pin which model each agent kind runs on for this workspace.
            </p>
          </div>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="sm"
            class="ml-auto"
            title="Close (Esc)"
            @click="open = false"
          />
        </header>

        <div class="flex-1 overflow-auto px-6 py-6">
          <div class="mx-auto max-w-3xl space-y-5">
            <p class="text-sm leading-relaxed text-slate-400">
              Pin which model each agent kind runs on for this workspace, e.g. a strong reasoning
              model for the architect, a cheaper one for the documenter. A kind left on its
              <span class="text-slate-300">deployment default</span> uses the server's configured
              routing (named on the button). A model pinned on an individual task still overrides
              these.
            </p>

            <UInput
              v-model="filter"
              icon="i-lucide-search"
              size="sm"
              placeholder="Filter models…"
              class="w-full"
            >
              <template v-if="filter" #trailing>
                <UButton
                  icon="i-lucide-x"
                  color="neutral"
                  variant="link"
                  size="xs"
                  aria-label="Clear filter"
                  @click="filter = ''"
                />
              </template>
            </UInput>

            <p v-if="models.models.length === 0" class="py-4 text-center text-sm text-slate-500">
              Loading model catalog…
            </p>

            <div
              v-else
              class="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/50"
            >
              <div
                v-for="a in agents.archetypes"
                :key="a.kind"
                class="flex items-center gap-3 px-4 py-3"
              >
                <UIcon :name="a.icon" class="h-4 w-4 shrink-0" :style="{ color: a.color }" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm text-slate-200">{{ a.label }}</p>
                </div>
                <UDropdownMenu
                  :items="menuFor(a.kind)"
                  :ui="{ content: 'max-h-72 overflow-y-auto' }"
                >
                  <UButton
                    size="xs"
                    :color="defaults.forKind(a.kind) ? 'primary' : 'neutral'"
                    :variant="defaults.forKind(a.kind) ? 'subtle' : 'soft'"
                    trailing-icon="i-lucide-chevron-down"
                    :loading="busy === a.kind"
                  >
                    {{ buttonLabel(a.kind) }}
                  </UButton>
                </UDropdownMenu>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.reader-fade-enter-active,
.reader-fade-leave-active {
  transition: opacity 0.18s ease;
}
.reader-fade-enter-from,
.reader-fade-leave-to {
  opacity: 0;
}
</style>
