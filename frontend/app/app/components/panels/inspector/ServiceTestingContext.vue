<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TESTING_CONTEXT_MAX_LENGTH } from '@cat-factory/contracts'
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import { rehydratedDraft } from '~/components/panels/inspector/ServiceTestingContext.logic'
import { showOverrideField } from '~/utils/uiMode'

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
const uiMode = useUiModeStore()
const toast = useToast()
const { t } = useI18n()

const busy = ref(false)
const draft = ref(props.block.testingContext ?? '')

// Re-hydrate from the block when the persisted value moves, but never over what the operator has
// typed (`rehydratedDraft` owns the rule and its spec states each case). The board store patches
// optimistically and ROLLS BACK on a rejected write, so a failed save arrives here looking exactly
// like a teammate's edit; taking it would erase the prose the toast is telling the operator to try
// saving again.
watch(
  () => props.block.testingContext ?? '',
  (incoming, previous) => {
    draft.value = rehydratedDraft({ draft: draft.value, previous, incoming, saving: busy.value })
  },
)

const saved = computed(() => props.block.testingContext ?? '')
// What a save would SEND, which is what the server would store: the request trims before it caps,
// so trailing whitespace is neither length spent nor a change worth a request.
const outgoing = computed(() => draft.value.trim())
const tooLong = computed(() => outgoing.value.length > TESTING_CONTEXT_MAX_LENGTH)
const dirty = computed(() => outgoing.value !== saved.value)
const canSave = computed(() => !busy.value && dirty.value && !tooLong.value)

// Standing per-service configuration, not part of the everyday delivery loop: a service is briefed
// once and every task then ships without anyone opening this. Absent, every tester prompt is
// byte-identical to one written before the field existed, which is what makes hiding it honest at
// the basic tier. `showOverrideField` (not a bare `isAdvanced`) because a service that HAS been
// briefed must show its prose to whoever opens the inspector: nothing else in the SPA surfaces
// what the testers are being told, so hiding a filled box would leave a basic-tier user unable to
// read, correct or clear it. The ROLE axis needs no separate answer: `intake` is capped at basic
// and never configures the platform, so this reaches the same people the tier bar admits.
const show = computed(() => showOverrideField(uiMode.isAdvanced, saved.value))

async function save() {
  busy.value = true
  try {
    // `updateBlock` reports its own failure (it rolls back and toasts), so only the success
    // needs saying here; announcing it unconditionally would claim a save the rollback undid.
    const persisted = await board.updateBlock(props.block.id, { testingContext: outgoing.value })
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
    v-if="show"
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
        {{
          t('inspector.testingContext.length', {
            count: outgoing.length,
            max: TESTING_CONTEXT_MAX_LENGTH,
          })
        }}
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
