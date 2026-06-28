<script setup lang="ts">
import type { Block } from '~/types/domain'

// Service-level best-practice fragments (frame blocks). These are the programming
// standards/guidelines for the whole service; at run time their bodies are folded
// into the prompt of every `code-aware` agent on tasks under this service. Drawn from
// the universal fragment pool (built-in + deployment-registered), grouped by category.
const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const fragments = useFragmentsStore()
const { t } = useI18n()

onMounted(() => fragments.ensureLoaded())

const selectedFragments = computed(() =>
  (props.block.serviceFragmentIds ?? [])
    .map((id) => fragments.getFragment(id))
    .filter((f): f is NonNullable<typeof f> => !!f),
)

// Picker menu: every pool fragment not already selected, grouped by category.
const fragmentMenu = computed(() => {
  const selected = new Set(props.block.serviceFragmentIds ?? [])
  const groups = new Map<string, { label: string; onSelect: () => void }[]>()
  for (const f of fragments.fragments) {
    if (selected.has(f.id)) continue
    const items = groups.get(f.category) ?? []
    items.push({ label: f.title, onSelect: () => addFragment(f.id) })
    groups.set(f.category, items)
  }
  return [...groups.values()]
})

function addFragment(id: string) {
  const list = props.block.serviceFragmentIds ? [...props.block.serviceFragmentIds] : []
  if (!list.includes(id)) list.push(id)
  board.updateBlock(props.block.id, { serviceFragmentIds: list })
}

function removeFragment(id: string) {
  if (!props.block.serviceFragmentIds) return
  board.updateBlock(props.block.id, {
    serviceFragmentIds: props.block.serviceFragmentIds.filter((x) => x !== id),
  })
}
</script>

<template>
  <div>
    <div class="mb-1 flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.fragments.serviceTitle') }}
      </span>
      <UDropdownMenu v-if="fragmentMenu.length" :items="fragmentMenu">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-plus"
          trailing-icon="i-lucide-chevron-down"
        />
      </UDropdownMenu>
    </div>
    <div v-if="selectedFragments.length" class="mb-1 flex flex-wrap gap-1">
      <UBadge
        v-for="f in selectedFragments"
        :key="f.id"
        color="primary"
        variant="subtle"
        size="sm"
        class="cursor-pointer"
        :title="f.summary"
        @click="removeFragment(f.id)"
      >
        {{ f.title }}<UIcon name="i-lucide-x" class="ml-0.5 h-3 w-3" />
      </UBadge>
    </div>
    <div v-else class="text-[11px] text-slate-500">
      {{ t('inspector.fragments.serviceEmpty') }}
    </div>
  </div>
</template>
