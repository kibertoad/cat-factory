<script setup lang="ts">
// Shared best-practice prompt-fragment picker: a category-grouped MULTI-SELECT popover (with links
// out to the fragment library) plus the currently-selected fragments as removable badges.
// Selecting a row TOGGLES it and leaves the list open, so several fragments can be picked (and
// unpicked) in one visit; a dedicated "Done" button closes the panel.
// Presentational + `v-model`-driven — the caller owns WHERE the selection lives (a task's
// `fragmentIds`, a service's `serviceFragmentIds`, or a not-yet-created task's local draft) and
// binds the id list. Authored once and reused by the create-task form and the task/service
// inspectors so the three pickers can't drift. Ids the catalog no longer resolves still render
// (labelled by their raw id) so they stay visible and removable.
import type { PromptFragment } from '~/types/domain'
import { buildFragmentCategoryGroups } from '~/utils/fragmentPicker'

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

const open = ref(false)

// The catalog is per-board and invalidated on a workspace switch; (re)load it lazily — a no-op
// while current.
onMounted(() => fragments.ensureLoaded())

const selectedFragments = computed(() =>
  props.modelValue.map((id) => fragments.getFragment(id) ?? { id, title: id, summary: '' }),
)

const selectedSet = computed(() => new Set(props.modelValue))

// Pool fragments bucketed into labelled per-category sections. Selected rows stay in the list so
// they can be unpicked in place (a check marks the current selection).
const categoryGroups = computed(() => buildFragmentCategoryGroups(props.pool))

function toggleFragment(id: string) {
  if (props.modelValue.includes(id)) {
    removeFragment(id)
  } else {
    emit('update:modelValue', [...props.modelValue, id])
  }
}

function removeFragment(id: string) {
  emit(
    'update:modelValue',
    props.modelValue.filter((x) => x !== id),
  )
}

function manageBoard() {
  open.value = false
  ui.openFragmentLibrary()
}

function manageAccount() {
  open.value = false
  ui.openAccountSettings('fragments')
}
</script>

<template>
  <div>
    <div class="mb-1 flex items-center justify-between gap-2">
      <span v-if="label" class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ label }}
      </span>
      <span v-else />
      <UPopover v-model:open="open" :content="{ align: 'end' }">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-plus"
          trailing-icon="i-lucide-chevron-down"
          data-testid="fragment-add"
        />

        <template #content>
          <div
            class="flex max-h-[24rem] w-[min(22rem,92vw)] flex-col"
            data-testid="fragment-picker-panel"
          >
            <div class="min-h-0 flex-1 overflow-y-auto p-1">
              <template v-if="categoryGroups.length">
                <div v-for="group in categoryGroups" :key="group.category">
                  <p
                    class="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                  >
                    {{ group.category }}
                  </p>
                  <button
                    v-for="f in group.fragments"
                    :key="f.id"
                    type="button"
                    class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-slate-800/60"
                    :class="selectedSet.has(f.id) ? 'text-slate-100' : 'text-slate-300'"
                    :title="f.summary"
                    :data-testid="`fragment-option-${f.id}`"
                    :aria-pressed="selectedSet.has(f.id)"
                    @click="toggleFragment(f.id)"
                  >
                    <UIcon
                      :name="selectedSet.has(f.id) ? 'i-lucide-check' : 'i-lucide-plus'"
                      class="h-4 w-4 shrink-0"
                      :class="selectedSet.has(f.id) ? 'text-primary-400' : 'text-slate-500'"
                    />
                    <span class="flex-1 truncate">{{ f.title }}</span>
                  </button>
                </div>
              </template>
              <p v-else class="px-2 py-3 text-[12px] text-slate-500">
                {{ t('inspector.fragments.pickerEmpty') }}
              </p>

              <div class="mt-1 border-t border-slate-800 pt-1">
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm text-slate-300 hover:bg-slate-800/60"
                  @click="manageBoard"
                >
                  <UIcon name="i-lucide-book-marked" class="h-4 w-4 shrink-0 text-slate-400" />
                  <span class="flex-1 truncate">{{ t('inspector.fragments.manageBoard') }}</span>
                </button>
                <button
                  v-if="accounts.enabled"
                  type="button"
                  class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm text-slate-300 hover:bg-slate-800/60"
                  @click="manageAccount"
                >
                  <UIcon name="i-lucide-users" class="h-4 w-4 shrink-0 text-slate-400" />
                  <span class="flex-1 truncate">{{ t('inspector.fragments.manageAccount') }}</span>
                </button>
              </div>
            </div>

            <div class="flex justify-end border-t border-slate-800 p-1.5">
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                data-testid="fragment-picker-done"
                @click="open = false"
              >
                {{ t('inspector.fragments.done') }}
              </UButton>
            </div>
          </div>
        </template>
      </UPopover>
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
