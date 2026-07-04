<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import { buildFragmentPickerGroups } from '~/utils/fragmentPicker'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const fragments = useFragmentsStore()
const ui = useUiStore()
const accounts = useAccountsStore()
const { t } = useI18n()

// The catalog is per-board and invalidated on a workspace switch, so (re)load it when the
// task inspector mounts — mirrors ServiceFragments; ensureLoaded is a no-op while current.
onMounted(() => fragments.ensureLoaded())

// ---- best-practice prompt fragments ----------------------------------------
// Selected fragments, resolved against the catalog. An id the catalog no longer
// resolves (removed/suppressed after selection) still renders — labelled by its
// raw id — so it stays visible and removable.
const selectedFragments = computed(() =>
  (props.block.fragmentIds ?? []).map(
    (id) => fragments.getFragment(id) ?? { id, title: id, summary: '' },
  ),
)

// A trailing group that jumps from "attach a fragment" to authoring/editing the
// library itself (board tier always; account tier when accounts are enabled).
// Open to every member — managing fragments is not an admin-only action.
const manageItems = computed<DropdownMenuItem[]>(() => {
  const items: DropdownMenuItem[] = [
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
// grouped into labelled per-category sections so the dropdown reads like the catalog,
// with the management links appended as the final group.
const fragmentMenu = computed<DropdownMenuItem[][]>(() => {
  const selected = new Set(props.block.fragmentIds ?? [])
  return [
    ...buildFragmentPickerGroups(
      fragments.forBlockType(props.block.type),
      (id) => selected.has(id),
      addFragment,
    ),
    manageItems.value,
  ]
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
  <InspectorSection :title="t('inspector.structure.title')" :hint="t('inspector.structure.hint')">
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
      <p class="mt-1 text-[11px] leading-snug text-slate-500">
        {{ t('inspector.structure.moduleHint') }}
      </p>
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
      <p class="mt-1 text-[11px] leading-snug text-slate-500">
        {{ t('inspector.structure.bestPracticesHint') }}
      </p>
    </div>
  </InspectorSection>
</template>
