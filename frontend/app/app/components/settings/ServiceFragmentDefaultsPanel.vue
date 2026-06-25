<script setup lang="ts">
// Workspace settings: the default best-practice fragments NEW services inherit. The
// selection is drawn from the universal fragment pool (built-in + deployment-registered)
// served by GET /prompt-fragments. Changing it does not retroactively change existing
// services — each owns its selection from creation. Persisted via the
// serviceFragmentDefaults store (the backend replaces the whole list on each change).
import { onMounted, ref } from 'vue'

const fragments = useFragmentsStore()
const defaults = useServiceFragmentDefaultsStore()
const toast = useToast()

const busy = ref(false)

// The tab renders when Workspace settings opens; load the fragment pool then.
onMounted(() => void fragments.ensureLoaded())

const selected = computed(() =>
  defaults.fragmentIds
    .map((id) => fragments.getFragment(id))
    .filter((f): f is NonNullable<typeof f> => !!f),
)

// Pool fragments not already in the default set, grouped by category.
const menu = computed(() => {
  const chosen = new Set(defaults.fragmentIds)
  const groups = new Map<string, { label: string; onSelect: () => void }[]>()
  for (const f of fragments.fragments) {
    if (chosen.has(f.id)) continue
    const items = groups.get(f.category) ?? []
    items.push({ label: f.title, onSelect: () => add(f.id) })
    groups.set(f.category, items)
  }
  return [...groups.values()]
})

async function save(ids: string[]) {
  busy.value = true
  try {
    await defaults.set(ids)
  } catch (e) {
    toast.add({
      title: 'Could not save default fragments',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

function add(id: string) {
  if (defaults.fragmentIds.includes(id)) return
  void save([...defaults.fragmentIds, id])
}

function remove(id: string) {
  void save(defaults.fragmentIds.filter((x) => x !== id))
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-slate-400">
      Pick the best-practice fragments every <span class="text-slate-300">new</span> service starts
      with. Their guidance is folded into the prompt of every
      <span class="text-slate-300">code-aware</span> agent (coder, reviewer, architect, fixers) on
      the service's tasks. You can refine the set per service in its inspector; changing this
      default does not affect services that already exist.
    </p>

    <div class="flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Default fragments
      </span>
      <UDropdownMenu v-if="menu.length" :items="menu" :ui="{ content: 'max-h-72 overflow-y-auto' }">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-plus"
          trailing-icon="i-lucide-chevron-down"
          :loading="busy"
        >
          Add fragment
        </UButton>
      </UDropdownMenu>
    </div>

    <div v-if="selected.length" class="flex flex-wrap gap-1">
      <UBadge
        v-for="f in selected"
        :key="f.id"
        color="primary"
        variant="subtle"
        size="sm"
        class="cursor-pointer"
        :title="f.summary"
        @click="remove(f.id)"
      >
        {{ f.title }}<UIcon name="i-lucide-x" class="ml-0.5 h-3 w-3" />
      </UBadge>
    </div>
    <p v-else class="text-[11px] text-slate-500">
      None — new services start with no service-level fragments.
    </p>
  </div>
</template>
