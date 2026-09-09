<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'

// Per-service (frame) TESTING CONTEXT: freeform prose about how this service is tested, which
// the engine injects verbatim into every tester prompt for it: the pipeline testers and the
// environment dry run's prober alike. It sits beside the sealed test credentials because the
// two are halves of one answer: the credentials are the material, this is what to do with it.
//
// Non-sensitive by contract: it is rendered INTO the prompt, so a real secret belongs one panel
// up, in the sealed store, and this prose refers to it by variable name. The banner says so.
//
// It is a plain block field (like the provisioning config), so it saves through the board store's
// `updateBlock` rather than a store of its own, and the draft below is what makes it an explicit
// save instead of a keystroke-per-request.
const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const toast = useToast()
const { t } = useI18n()

/** Mirrors the contract's `updateBlockSchema.testingContext` cap. */
const MAX = 8000

const busy = ref(false)
const draft = ref('')

// Re-hydrate from the block whenever the persisted value changes. A live board event carrying
// another tab's edit lands here too, and an in-flight draft is not clobbered because the value
// only changes when the server confirmed one.
watch(
  () => props.block.testingContext ?? '',
  (value) => {
    draft.value = value
  },
  { immediate: true },
)

const saved = computed(() => props.block.testingContext ?? '')
const tooLong = computed(() => draft.value.length > MAX)
const dirty = computed(() => draft.value !== saved.value)
const canSave = computed(() => !busy.value && dirty.value && !tooLong.value)

async function save() {
  busy.value = true
  try {
    // `updateBlock` reports its own failure (it rolls back and toasts), so only the success
    // needs saying here; announcing it unconditionally would claim a save the rollback undid.
    const persisted = await board.updateBlock(props.block.id, { testingContext: draft.value })
    if (persisted) {
      toast.add({
        title: t('inspector.testingContext.savedToast'),
        icon: 'i-lucide-check',
        color: 'success',
      })
    }
  } finally {
    busy.value = false
  }
}

function revert() {
  draft.value = saved.value
}
</script>

<template>
  <InspectorSection
    :title="t('inspector.testingContext.title')"
    :hint="t('inspector.testingContext.sectionHint')"
    data-testid="service-testing-context"
  >
    <!-- This text reaches the model in the prompt, so it must never hold a real secret. -->
    <div
      class="flex items-start gap-2 rounded-md border border-slate-700 bg-slate-800/40 px-2.5 py-2 text-[11px] leading-snug text-slate-300"
    >
      <UIcon name="i-lucide-info" class="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
      <span>{{ t('inspector.testingContext.notSecret') }}</span>
    </div>

    <UTextarea
      v-model="draft"
      :rows="8"
      :placeholder="t('inspector.testingContext.placeholder')"
      class="w-full"
      data-testid="testing-context-input"
    />

    <div class="flex items-center justify-between gap-2">
      <p class="text-[11px] text-slate-500" :class="{ 'text-error-400': tooLong }">
        {{ t('inspector.testingContext.length', { count: draft.length, max: MAX }) }}
      </p>
      <div class="flex items-center gap-2">
        <UButton
          v-if="dirty"
          color="neutral"
          variant="ghost"
          size="xs"
          data-testid="testing-context-revert"
          @click="revert"
        >
          {{ t('inspector.testingContext.revert') }}
        </UButton>
        <UButton
          color="primary"
          variant="soft"
          size="xs"
          icon="i-lucide-save"
          :loading="busy"
          :disabled="!canSave"
          data-testid="testing-context-save"
          @click="save"
        >
          {{ t('inspector.testingContext.save') }}
        </UButton>
      </div>
    </div>
  </InspectorSection>
</template>
