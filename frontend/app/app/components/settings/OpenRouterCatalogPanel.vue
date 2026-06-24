<script setup lang="ts">
// Workspace settings: "OpenRouter models" — browse OpenRouter's 300+ gateway models and
// enable a subset for this workspace. OpenRouter is reached via the workspace's API-key pool
// (connect an OpenRouter key first under "Provider keys"); "Refresh" probes its live catalog
// server-side, then tick the models to enable. Enabled models — with their context window and
// price — appear automatically in the model picker and meter against the spend budget.
import { computed, ref, watch } from 'vue'
import type { OpenRouterModelMeta } from '~/types/openrouter'

const ui = useUiStore()
const workspace = useWorkspaceStore()
const store = useOpenRouterStore()
const toast = useToast()

const open = computed({
  get: () => ui.openRouterOpen,
  set: (v: boolean) => (v ? ui.openOpenRouter() : ui.closeOpenRouter()),
})

// The enabled slugs the user has ticked (seeded from the persisted catalog on open).
const selected = ref<Set<string>>(new Set())
const filter = ref('')
const busy = ref(false)

// Load the persisted catalog whenever the panel opens; seed the tick selection from it.
watch(open, (isOpen) => {
  if (!isOpen || !workspace.workspaceId) return
  void store.load(workspace.workspaceId).then(() => {
    selected.value = new Set(store.enabled.map((m) => m.id))
  })
})

// The list to show: the live browse list once refreshed, else the persisted enabled set.
const source = computed<OpenRouterModelMeta[]>(() =>
  store.browse.length ? store.browse : store.enabled,
)

const visible = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return source.value
  return source.value.filter(
    (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
  )
})

const selectedCount = computed(() => selected.value.size)

function contextLabel(tokens: number | undefined): string {
  if (!tokens) return ''
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K ctx` : `${tokens} ctx`
}

function priceLabel(m: OpenRouterModelMeta): string {
  return `${m.inputPerMillion}/${m.outputPerMillion} per Mtok`
}

function toggle(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}

async function refresh() {
  if (!workspace.workspaceId) return
  const result = await store.refresh(workspace.workspaceId)
  if (!result.reachable) {
    toast.add({
      title: 'Could not reach OpenRouter',
      description: store.refreshError ?? 'Connect an OpenRouter key under Provider keys first.',
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

async function save() {
  if (!workspace.workspaceId) return
  busy.value = true
  try {
    // Persist the ticked models, carrying the metadata from whichever list they came from.
    const byId = new Map(source.value.map((m) => [m.id, m]))
    const models = [...selected.value].map((id) => byId.get(id)).filter((m): m is OpenRouterModelMeta => !!m)
    await store.save(workspace.workspaceId, models)
    toast.add({ title: 'OpenRouter catalog saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not save catalog',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="OpenRouter models" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-slate-400">
          Reach <strong>300+ models</strong> through one gateway. Connect an OpenRouter key under
          <span class="text-slate-300">Provider keys</span> first, then
          <span class="text-slate-300">Refresh</span> to browse the live catalog and enable the
          models you want. Enabled models appear in the model picker with their context window and
          price, and meter against your spend budget.
        </p>

        <div class="flex items-center gap-2">
          <UButton
            color="neutral"
            variant="soft"
            size="sm"
            icon="i-lucide-refresh-cw"
            :loading="store.refreshing"
            @click="refresh()"
          >
            Refresh catalog
          </UButton>
          <UInput
            v-model="filter"
            size="sm"
            class="flex-1"
            icon="i-lucide-search"
            placeholder="Filter by name or slug…"
          />
        </div>

        <p v-if="store.refreshError" class="text-xs text-rose-400">{{ store.refreshError }}</p>

        <div v-if="visible.length" class="max-h-96 space-y-1 overflow-y-auto pr-1">
          <label
            v-for="m in visible"
            :key="m.id"
            class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-2.5 py-1.5 text-sm"
          >
            <UCheckbox
              :model-value="selected.has(m.id)"
              @update:model-value="(v: boolean | 'indeterminate') => toggle(m.id, v === true)"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-slate-200">{{ m.name }}</span>
              <span class="block truncate font-mono text-[11px] text-slate-500">{{ m.id }}</span>
            </span>
            <span class="shrink-0 text-right text-[11px] text-slate-500">
              <span v-if="m.contextLength" class="block">{{ contextLabel(m.contextLength) }}</span>
              <span class="block">{{ priceLabel(m) }}</span>
            </span>
          </label>
        </div>
        <p v-else class="text-xs text-slate-500">
          No models yet — hit <span class="text-slate-300">Refresh catalog</span> to load OpenRouter's
          live list.
        </p>

        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-500">{{ selectedCount }} enabled</span>
          <UButton
            color="primary"
            variant="soft"
            size="sm"
            icon="i-lucide-save"
            :loading="busy"
            @click="save()"
          >
            Save
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
