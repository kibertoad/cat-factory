<script setup lang="ts">
// The answers to a CUSTOM task type's own declared fields, editable after creation.
//
// Why it exists: the create form is not the only door a task arrives through (the public API, an
// initiative spawn, a tracker import), and a type's declaration can get STRICTER after a task
// already exists. The pre-dispatch input gate judges the declaration as it stands now, so it
// parks runs whose task predates the requirement. Without this panel that park had exactly one
// exit, a human waiving the gate: `recheck` would re-read the same unanswered bag forever, and
// the remedy the notice names ("fill it in on the task") would be one nothing offered.
//
// Renders through the SAME `DescriptorFields` component the create form uses, against the SAME
// declaration, validated by the SAME shared rule. A field the form would have hidden by its
// `showWhen` is hidden here too, so the two doors cannot show a person different questions.
import { computed, ref, watch } from 'vue'
import type { DescriptorFieldValues } from '@cat-factory/contracts'
import { sanitizeDescriptorFields, validateDescriptorFields } from '@cat-factory/contracts'
import type { Block } from '~/types/domain'
import DescriptorFields from '~/components/common/DescriptorFields.vue'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const taskTypes = useTaskTypesStore()
const { t } = useI18n()

/** The registered type this task is, or undefined for a built-in / unregistered one. */
const descriptor = computed(() =>
  props.block.taskType
    ? taskTypes.customTaskTypes.find((tt) => tt.taskType === props.block.taskType)
    : undefined,
)

/**
 * The fields to render. A type carrying a bespoke `formPanel` owns its whole bag, so its
 * descriptor fields are not what was collected and editing them here would write values its own
 * form never offered. That is the same stand-down the create door and the input gate take, and
 * all three have to agree or "the declaration" would mean three different things.
 */
const fields = computed(() => (descriptor.value?.formPanel ? [] : (descriptor.value?.fields ?? [])))

const stored = computed<DescriptorFieldValues>(() => props.block.taskTypeFields?.custom ?? {})

// Local edit buffer, re-seeded whenever the stored bag changes underneath (a live board push, or
// switching blocks). Editing writes on commit rather than per keystroke, so a half-typed answer
// never reaches the row the gate reads.
const draft = ref<DescriptorFieldValues>({ ...stored.value })
watch(stored, (next) => {
  draft.value = { ...next }
})

/**
 * The same check the server runs, so the button reflects an invalid form rather than the save
 * failing with a 422. Shared from contracts precisely so the two cannot drift.
 */
const problems = computed(() => validateDescriptorFields(fields.value, draft.value))

const dirty = computed(
  () =>
    JSON.stringify(sanitizeDescriptorFields(fields.value, draft.value)) !==
    JSON.stringify(stored.value),
)

const saving = ref(false)

async function save() {
  if (problems.value.length || !dirty.value) return
  saving.value = true
  try {
    await board.updateBlock(props.block.id, {
      customTaskTypeFields: sanitizeDescriptorFields(fields.value, draft.value),
    })
  } finally {
    saving.value = false
  }
}

function revert() {
  draft.value = { ...stored.value }
}
</script>

<template>
  <InspectorSection
    v-if="fields.length"
    :title="t('inspector.taskTypeFields.title')"
    :hint="t('inspector.taskTypeFields.hint')"
    icon="i-lucide-clipboard-list"
    :count="fields.length"
  >
    <DescriptorFields v-model="draft" :fields="fields" testid-prefix="task-type-field" />
    <div v-if="dirty" class="mt-2 flex items-center gap-2">
      <UButton
        size="xs"
        color="primary"
        variant="soft"
        :loading="saving"
        :disabled="problems.length > 0"
        data-testid="task-type-fields-save"
        @click="save"
      >
        {{ t('inspector.taskTypeFields.save') }}
      </UButton>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        data-testid="task-type-fields-revert"
        @click="revert"
      >
        {{ t('inspector.taskTypeFields.revert') }}
      </UButton>
    </div>
  </InspectorSection>
</template>
