<script setup lang="ts">
// The specialist review playbooks a REVIEW task queues onto its run: a Performance Review, a
// Security Review, whatever the team authored. Picked here at task creation, stored on the task as
// `taskTypeFields.reviewSkillIds`, and resolved per dispatch onto the reviewer's own skills.
//
// Only the catalog's `review` group is offered. A skill declares what kind of work it does, so a
// scaffolding playbook has no business in a picker whose job is to add review lenses; the store's
// `reviewSkills` owns that filter and this component never re-derives it.
//
// ORDER is the point, which is why the selection renders as numbered badges rather than as a set:
// the reviewer applies the queue in the order it was picked, so the person picking has to be able
// to see (and change) that order. Clicking a badge removes it; picking again appends.
//
// Presentational and `v-model`-driven, like `FragmentSelector`: the caller owns where the list
// lives, so the create form and any later editor bind the same component.
import { computed, ref } from 'vue'
import { MAX_REVIEW_SKILLS } from '@cat-factory/contracts'
import { useSkillsStore } from '~/stores/skills'

const props = defineProps<{
  /** The queued skill ids, in the order the reviewer applies them (`v-model`). */
  modelValue: string[]
}>()
const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const skills = useSkillsStore()
const { t } = useI18n()

const open = ref(false)

const offered = computed(() => skills.reviewSkills)
const selectedSet = computed(() => new Set(props.modelValue))
/** Queued skills in QUEUE order (not catalog order), so the badges read as the run's sequence. */
const queued = computed(() =>
  props.modelValue.map(
    (id) => offered.value.find((s) => s.id === id) ?? { id, name: id, description: '' },
  ),
)
/** At the cap, unpicked rows stop being offered: the reviewer carries every queued skill's text. */
const atCap = computed(() => props.modelValue.length >= MAX_REVIEW_SKILLS)

function toggle(id: string) {
  if (selectedSet.value.has(id)) {
    emit(
      'update:modelValue',
      props.modelValue.filter((x) => x !== id),
    )
    return
  }
  if (atCap.value) return
  emit('update:modelValue', [...props.modelValue, id])
}
</script>

<template>
  <div>
    <div class="mb-1 flex items-center justify-between gap-2">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('board.addTask.review.skills.label') }}
      </span>
      <UPopover v-model:open="open" :content="{ align: 'end' }">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-plus"
          trailing-icon="i-lucide-chevron-down"
          data-testid="review-skill-add"
        />

        <template #content>
          <div
            class="flex max-h-[24rem] w-[min(24rem,92vw)] flex-col"
            data-testid="review-skill-picker-panel"
          >
            <div class="min-h-0 flex-1 overflow-y-auto p-1">
              <template v-if="offered.length">
                <button
                  v-for="s in offered"
                  :key="s.id"
                  type="button"
                  class="flex w-full items-start gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-40"
                  :class="selectedSet.has(s.id) ? 'text-slate-100' : 'text-slate-300'"
                  :disabled="atCap && !selectedSet.has(s.id)"
                  :aria-pressed="selectedSet.has(s.id)"
                  :data-testid="`review-skill-option-${s.id}`"
                  @click="toggle(s.id)"
                >
                  <UIcon
                    :name="selectedSet.has(s.id) ? 'i-lucide-check' : 'i-lucide-plus'"
                    class="mt-0.5 h-4 w-4 shrink-0"
                    :class="selectedSet.has(s.id) ? 'text-primary-400' : 'text-slate-500'"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{{ s.name }}</span>
                    <span class="block truncate text-[11px] text-slate-500">
                      {{ s.description }}
                    </span>
                  </span>
                </button>
              </template>
              <p v-else class="px-2 py-3 text-[12px] text-slate-500">
                {{ t('board.addTask.review.skills.pickerEmpty') }}
              </p>
            </div>

            <p
              v-if="atCap"
              class="border-t border-slate-800 px-2 py-1.5 text-[11px] text-amber-400"
            >
              {{ t('board.addTask.review.skills.capped', { max: MAX_REVIEW_SKILLS }) }}
            </p>
            <div class="flex justify-end border-t border-slate-800 p-1.5">
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                data-testid="review-skill-picker-done"
                @click="open = false"
              >
                {{ t('board.addTask.review.skills.done') }}
              </UButton>
            </div>
          </div>
        </template>
      </UPopover>
    </div>
    <div v-if="queued.length" class="flex flex-wrap gap-1">
      <UBadge
        v-for="(s, i) in queued"
        :key="s.id"
        color="primary"
        variant="subtle"
        size="sm"
        class="cursor-pointer"
        :title="s.description"
        data-testid="review-skill-badge"
        @click="toggle(s.id)"
      >
        <span class="me-1 tabular-nums text-slate-400">{{ i + 1 }}</span>
        {{ s.name }}<UIcon name="i-lucide-x" class="ms-0.5 h-3 w-3" />
      </UBadge>
    </div>
    <p v-else class="text-[11px] text-slate-500">
      {{ t('board.addTask.review.skills.hint') }}
    </p>
  </div>
</template>
