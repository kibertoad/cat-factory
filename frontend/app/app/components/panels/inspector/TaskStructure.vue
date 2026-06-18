<script setup lang="ts">
import type { Block } from '~/types/domain'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const fragments = useFragmentsStore()

// ---- best-practice prompt fragments ----------------------------------------
// Selected fragments (resolved against the catalog; unknown ids are dropped).
const selectedFragments = computed(() =>
  (props.block.fragmentIds ?? [])
    .map((id) => fragments.getFragment(id))
    .filter((f): f is NonNullable<typeof f> => !!f),
)

// Picker menu: fragments suitable for this block's type, not already selected,
// grouped by category so the dropdown reads like the catalog.
const fragmentMenu = computed(() => {
  const selected = new Set(props.block.fragmentIds ?? [])
  const groups = new Map<string, { label: string; onSelect: () => void }[]>()
  for (const f of fragments.forBlockType(props.block.type)) {
    if (selected.has(f.id)) continue
    const items = groups.get(f.category) ?? []
    items.push({ label: f.title, onSelect: () => addFragment(f.id) })
    groups.set(f.category, items)
  }
  return [...groups.values()]
})

function addFragment(id: string) {
  const list = props.block.fragmentIds ? [...props.block.fragmentIds] : []
  if (!list.includes(id)) list.push(id)
  board.updateBlock(props.block.id, { fragmentIds: list })
}

function removeFragment(id: string) {
  if (!props.block.fragmentIds) return
  board.updateBlock(props.block.id, {
    fragmentIds: props.block.fragmentIds.filter((x) => x !== id),
  })
}
</script>

<template>
  <div class="space-y-4">
    <!-- module assignment -->
    <div>
      <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Module
      </div>
      <UInput
        v-model="block.moduleName"
        size="sm"
        class="w-full"
        placeholder="e.g. Sessions (created on implement if new)"
        icon="i-lucide-package"
      />
    </div>

    <!-- best practices (prompt fragments) -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Best practices
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
        None — agents follow their default guidance.
      </div>
    </div>
  </div>
</template>
