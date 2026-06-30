<script setup lang="ts">
import type { Block } from '~/types/domain'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const fragments = useFragmentsStore()
const ui = useUiStore()
const accounts = useAccountsStore()
const { t } = useI18n()

type MenuItem = { label: string; icon?: string; onSelect: () => void }

// ---- best-practice prompt fragments ----------------------------------------
// Selected fragments (resolved against the catalog; unknown ids are dropped).
const selectedFragments = computed(() =>
  (props.block.fragmentIds ?? [])
    .map((id) => fragments.getFragment(id))
    .filter((f): f is NonNullable<typeof f> => !!f),
)

// A trailing group that jumps from "attach a fragment" to authoring/editing the
// library itself (board tier always; account tier when accounts are enabled).
// Open to every member — managing fragments is not an admin-only action.
const manageItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [
    {
      label: t('inspector.fragments.manageBoard'),
      icon: 'i-lucide-book-marked',
      onSelect: () => ui.openFragmentLibrary(),
    },
  ]
  if (accounts.enabled) {
    items.push({
      label: t('inspector.fragments.manageAccount'),
      icon: 'i-lucide-users',
      onSelect: () => ui.openAccountSettings('fragments'),
    })
  }
  return items
})

// Picker menu: fragments suitable for this block's type, not already selected,
// grouped by category so the dropdown reads like the catalog, with the management
// links appended as the final group.
const fragmentMenu = computed<MenuItem[][]>(() => {
  const selected = new Set(props.block.fragmentIds ?? [])
  const groups = new Map<string, MenuItem[]>()
  for (const f of fragments.forBlockType(props.block.type)) {
    if (selected.has(f.id)) continue
    const items = groups.get(f.category) ?? []
    items.push({ label: f.title, onSelect: () => addFragment(f.id) })
    groups.set(f.category, items)
  }
  return [...groups.values(), manageItems.value]
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
        {{ t('inspector.structure.module') }}
      </div>
      <UInput
        v-model="block.moduleName"
        size="sm"
        class="w-full"
        :placeholder="t('inspector.structure.modulePlaceholder')"
        icon="i-lucide-package"
      />
    </div>

    <!-- best practices (prompt fragments) -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('inspector.structure.bestPractices') }}
        </span>
        <UDropdownMenu :items="fragmentMenu">
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
          {{ f.title }}<UIcon name="i-lucide-x" class="ms-0.5 h-3 w-3" />
        </UBadge>
      </div>
      <div v-else class="text-[11px] text-slate-500">
        {{ t('inspector.structure.bestPracticesEmpty') }}
      </div>
    </div>
  </div>
</template>
