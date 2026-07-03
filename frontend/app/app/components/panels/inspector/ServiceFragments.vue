<script setup lang="ts">
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'

// Service-level best-practice fragments (frame blocks). These are the programming
// standards/guidelines for the whole service; at run time their bodies are folded
// into the prompt of every `code-aware` agent on tasks under this service. Drawn from
// the board's merged fragment catalog (built-in ∪ registered ∪ account ∪ workspace,
// via the fragments store; static pool when the library is off), grouped by category.
// `defaultOpen` expands the section on surfaces that embed this as the primary content
// (the add-service modal); the inspector leaves it collapsed.
const props = defineProps<{ block: Block; defaultOpen?: boolean }>()

const board = useBoardStore()
const fragments = useFragmentsStore()
const ui = useUiStore()
const accounts = useAccountsStore()
const { t } = useI18n()

onMounted(() => fragments.ensureLoaded())

type MenuItem = { label: string; icon?: string; onSelect: () => void }

// An id the catalog no longer resolves (removed/suppressed after selection) still
// renders — labelled by its raw id — so it stays visible and removable.
const selectedFragments = computed(() =>
  (props.block.serviceFragmentIds ?? []).map(
    (id) => fragments.getFragment(id) ?? { id, title: id, summary: '' },
  ),
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

// Picker menu: every pool fragment not already selected, grouped by category, with
// the management links appended as the final group.
const fragmentMenu = computed<MenuItem[][]>(() => {
  const selected = new Set(props.block.serviceFragmentIds ?? [])
  const groups = new Map<string, MenuItem[]>()
  for (const f of fragments.fragments) {
    if (selected.has(f.id)) continue
    const items = groups.get(f.category) ?? []
    items.push({ label: f.title, onSelect: () => addFragment(f.id) })
    groups.set(f.category, items)
  }
  return [...groups.values(), manageItems.value]
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
  <InspectorSection
    :title="t('inspector.fragments.serviceTitle')"
    :hint="t('inspector.fragments.serviceHint')"
    :count="selectedFragments.length"
    :default-open="props.defaultOpen"
  >
    <template #actions>
      <UDropdownMenu :items="fragmentMenu">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-plus"
          trailing-icon="i-lucide-chevron-down"
        />
      </UDropdownMenu>
    </template>
    <div v-if="selectedFragments.length" class="flex flex-wrap gap-1">
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
      {{ t('inspector.fragments.serviceEmpty') }}
    </div>
  </InspectorSection>
</template>
