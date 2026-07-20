<script setup lang="ts">
// Shared best-practice prompt-fragment picker: a category-grouped "add" dropdown (with links out
// to the fragment library) plus the currently-selected fragments as removable badges.
// Presentational + `v-model`-driven — the caller owns WHERE the selection lives (a task's
// `fragmentIds`, a service's `serviceFragmentIds`, or a not-yet-created task's local draft) and
// binds the id list. Authored once and reused by the create-task form and the task/service
// inspectors so the three pickers can't drift. Ids the catalog no longer resolves still render
// (labelled by their raw id) so they stay visible and removable.
import type { DropdownMenuItem } from '@nuxt/ui'
import type { PromptFragment } from '~/types/domain'
import { buildFragmentPickerGroups } from '~/utils/fragmentPicker'

const props = withDefaults(
  defineProps<{
    /** The selected fragment ids (`v-model`). */
    modelValue: string[]
    /** Candidate pool to offer — e.g. `fragments.forBlockType(type)` or the whole catalog. */
    pool: PromptFragment[]
    /** Optional label rendered to the left of the add button (omit when a section supplies it). */
    label?: string
    /** Optional text shown when nothing is selected. */
    emptyText?: string
  }>(),
  { label: '', emptyText: '' },
)
const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const fragments = useFragmentsStore()
const ui = useUiStore()
const accounts = useAccountsStore()
const { t } = useI18n()

// The catalog is per-board and invalidated on a workspace switch; (re)load it lazily — a no-op
// while current.
onMounted(() => fragments.ensureLoaded())

const selectedFragments = computed(() =>
  props.modelValue.map((id) => fragments.getFragment(id) ?? { id, title: id, summary: '' }),
)

// A trailing group that jumps from "attach a fragment" to authoring/editing the library itself
// (board tier always; account tier when accounts are enabled). Open to every member.
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

// Picker menu: pool fragments not already selected, grouped into labelled per-category sections,
// with the management links appended as the final group.
const fragmentMenu = computed<DropdownMenuItem[][]>(() => {
  const selected = new Set(props.modelValue)
  return [
    ...buildFragmentPickerGroups(props.pool, (id) => selected.has(id), addFragment),
    manageItems.value,
  ]
})

function addFragment(id: string) {
  if (props.modelValue.includes(id)) return
  emit('update:modelValue', [...props.modelValue, id])
}

function removeFragment(id: string) {
  emit(
    'update:modelValue',
    props.modelValue.filter((x) => x !== id),
  )
}
</script>

<template>
  <div>
    <div class="mb-1 flex items-center justify-between gap-2">
      <span v-if="label" class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ label }}
      </span>
      <span v-else />
      <UDropdownMenu :items="fragmentMenu">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-plus"
          trailing-icon="i-lucide-chevron-down"
          data-testid="fragment-add"
        />
      </UDropdownMenu>
    </div>
    <div v-if="selectedFragments.length" class="flex flex-wrap gap-1">
      <UBadge
        v-for="f in selectedFragments"
        :key="f.id"
        color="primary"
        variant="subtle"
        size="sm"
        class="cursor-pointer"
        :title="f.summary"
        data-testid="fragment-badge"
        @click="removeFragment(f.id)"
      >
        {{ f.title }}<UIcon name="i-lucide-x" class="ms-0.5 h-3 w-3" />
      </UBadge>
    </div>
    <div v-else-if="emptyText" class="text-[11px] text-slate-500">
      {{ emptyText }}
    </div>
  </div>
</template>
