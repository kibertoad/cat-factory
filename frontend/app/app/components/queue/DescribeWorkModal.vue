<script setup lang="ts">
import PipelinePicker from '~/components/pipeline/PipelinePicker.vue'
import RiskPolicyPicker from '~/components/riskPolicy/RiskPolicyPicker.vue'
import { parseConflict } from '~/composables/usePipelineErrorToast'
import { splitDescribedWork } from '~/utils/describeWork'
import { isReviewDebtConflict, reviewFrictionContext } from '~/utils/reviewFriction'
import { pipelineAllowedForManualStart } from '~/utils/pipeline'
import { showOverrideField } from '~/utils/uiMode'

/**
 * The preview's intake: what needs doing, which service, feature or bug. Nothing else on the
 * first screen.
 *
 * Every override the full "Add a task" form offers up front (pipeline, merge policy, model
 * preset) has a workspace default, so here they sit behind ONE "Change how this runs" disclosure
 * that names the defaults it would use. The disclosure opens by itself when a value is set, by the
 * same rule the inspector uses (`showOverrideField`), so nothing runs on a setting the reader
 * cannot see.
 *
 * The other task kinds and context attachments are not rebuilt here: "More kinds" and "Attach
 * context" hand the text over to the full form, prefilled, which is the one place those rules
 * live.
 */
const { t } = useI18n()
const preview = useHomePreviewStore()
const board = useBoardStore()
const ui = useUiStore()
const execution = useExecutionStore()
const pipelines = usePipelinesStore()
const riskPolicies = useRiskPoliciesStore()
const modelPresets = useModelPresetsStore()
const access = useWorkspaceAccess()
const toast = useToast()
const { present } = usePipelineErrorToast()
const pipelineFor = useStartPipelineResolver()

const open = computed({
  get: () => preview.describeWorkOpen,
  set: (v: boolean) => (v ? null : preview.closeDescribeWork()),
})

const text = ref('')
const serviceId = ref<string | undefined>(undefined)
/** The two kinds this dialog offers. Every other kind is the full form's (see "More kinds"). */
const kind = ref<'feature' | 'bug'>('feature')
const pipelineId = ref('')
const riskPolicyId = ref('')
const modelPresetId = ref('')
const saving = ref(false)

const services = computed(() => board.frames.filter((f) => f.type !== 'document'))
const serviceItems = computed(() => services.value.map((s) => ({ label: s.title, value: s.id })))
const service = computed(() => (serviceId.value ? board.getBlock(serviceId.value) : undefined))

onModalOpen(
  () => preview.describeWorkOpen,
  () => {
    text.value = ''
    kind.value = 'feature'
    pipelineId.value = ''
    riskPolicyId.value = ''
    modelPresetId.value = ''
    // The service the reader came from, else the only one there is. With several and no context,
    // nothing is preselected: guessing a service once pushed a task into the wrong repository.
    serviceId.value =
      preview.describeWorkServiceId ??
      (services.value.length === 1 ? services.value[0]!.id : undefined)
  },
)

const split = computed(() => splitDescribedWork(text.value))
const canSubmit = computed(
  () => !!split.value.title && !!service.value && !saving.value && access.canWriteBoard.value,
)

const selectablePipelines = computed(() =>
  pipelines.pipelines.filter((p) =>
    pipelineAllowedForManualStart(p, service.value, board.blocks, kind.value, 'task'),
  ),
)

/** What each override resolves to when left empty, for the disclosure's one-line summary. */
const summary = computed(() => {
  const pipeline = pipelineId.value
    ? pipelines.getPipeline(pipelineId.value)?.name
    : pipelineFor({ pipelineId: undefined })?.name
  const policy = riskPolicyId.value
    ? riskPolicies.presets.find((p) => p.id === riskPolicyId.value)?.name
    : riskPolicies.defaultPreset?.name
  const preset = modelPresetId.value
    ? modelPresets.presets.find((p) => p.id === modelPresetId.value)?.name
    : modelPresets.defaultPreset?.name
  return [pipeline, policy, preset].filter(Boolean).join(' · ')
})
const anyOverride = computed(() =>
  showOverrideField(false, pipelineId.value, riskPolicyId.value, modelPresetId.value),
)
const overridesOpen = ref(false)
watch(anyOverride, (set) => set && (overridesOpen.value = true), { immediate: true })

const KIND_LABEL_KEYS: Record<'feature' | 'bug', string> = {
  feature: 'describeWork.kind.feature',
  bug: 'describeWork.kind.bug',
}

// A select item cannot carry an empty value, so "the workspace default" has its own sentinel
// and maps back to the empty string the create call reads as "no override".
const DEFAULT_PRESET = '__workspace_default__'
const modelPresetItems = computed(() => [
  { label: t('describeWork.workspaceDefault'), value: DEFAULT_PRESET },
  ...modelPresets.presets.map((p) => ({ label: p.name, value: p.id })),
])
const modelPresetValue = computed({
  get: () => modelPresetId.value || DEFAULT_PRESET,
  set: (v: string) => (modelPresetId.value = v === DEFAULT_PRESET ? '' : v),
})

/** Hand the text to the full form, for a kind or an attachment this dialog does not offer. */
function openFullForm() {
  if (!service.value) return
  const { title, description } = split.value
  preview.closeDescribeWork()
  ui.openAddTask(service.value.id, { title, description })
}

async function submit(startNow: boolean, acknowledgeReviewDebt = false) {
  if (!service.value || !split.value.title || saving.value) return
  saving.value = true
  try {
    const { title, description } = split.value
    const block = await board.addTask(service.value.id, title, description, {
      taskType: kind.value,
      ...(pipelineId.value ? { pipelineId: pipelineId.value } : {}),
      ...(riskPolicyId.value ? { riskPolicyId: riskPolicyId.value } : {}),
      ...(modelPresetId.value ? { modelPresetId: modelPresetId.value } : {}),
      ...(acknowledgeReviewDebt ? { acknowledgeReviewDebt: true } : {}),
    })
    ui.closeReviewFriction()
    preview.closeDescribeWork()
    if (!block) return
    if (startNow) {
      const pipeline = pipelineFor(block)
      // `execution.start` reports its own refusals; a task that did not start stays in the queue
      // under "Not started", which is exactly where the reader will look for it.
      if (pipeline) await execution.start(block.id, pipeline)
    } else {
      toast.add({
        title: t('describeWork.addedToast', { title: block.title }),
        icon: 'i-lucide-list-plus',
        color: 'success',
      })
    }
  } catch (e) {
    const conflict = parseConflict(e)
    if (isReviewDebtConflict(conflict)) {
      ui.openReviewFriction(
        reviewFrictionContext(
          conflict,
          () => void submit(startNow, true),
          () => saving.value,
        ),
      )
      return
    }
    present(e, 'board.addTask.addFailedTitle')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('describeWork.title')" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <div class="space-y-4" data-testid="describe-work-modal">
        <UFormField :label="t('describeWork.textLabel')" :description="t('describeWork.textHint')">
          <UTextarea
            v-model="text"
            :rows="5"
            autoresize
            autofocus
            class="w-full"
            :placeholder="t('describeWork.textPlaceholder')"
            data-testid="describe-work-text"
          />
        </UFormField>
        <p v-if="split.title" class="-mt-2 text-2xs text-dimmed" data-testid="describe-work-title">
          {{ t('describeWork.savedAs', { title: split.title }) }}
        </p>

        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField :label="t('describeWork.serviceLabel')">
            <USelect
              v-model="serviceId"
              :items="serviceItems"
              :placeholder="t('describeWork.servicePlaceholder')"
              class="w-full"
              data-testid="describe-work-service"
            />
          </UFormField>
          <UFormField :label="t('describeWork.kindLabel')">
            <div class="flex items-center gap-1">
              <UButton
                v-for="k in ['feature', 'bug'] as const"
                :key="k"
                size="sm"
                :color="kind === k ? 'primary' : 'neutral'"
                :variant="kind === k ? 'soft' : 'ghost'"
                :data-testid="`describe-work-kind-${k}`"
                @click="kind = k"
              >
                {{ t(KIND_LABEL_KEYS[k]) }}
              </UButton>
              <UButton
                size="sm"
                color="neutral"
                variant="link"
                :disabled="!service"
                @click="openFullForm"
              >
                {{ t('describeWork.moreKinds') }}
              </UButton>
            </div>
          </UFormField>
        </div>

        <USeparator type="dashed" />

        <UCollapsible v-model:open="overridesOpen">
          <UButton
            color="neutral"
            variant="link"
            class="p-0"
            :icon="overridesOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            data-testid="describe-work-overrides"
          >
            <span>{{ t('describeWork.changeHowItRuns') }}</span>
            <span class="text-dimmed">({{ summary || t('describeWork.workspaceDefault') }})</span>
          </UButton>
          <template #content>
            <div class="mt-3 grid gap-3 sm:grid-cols-3">
              <UFormField :label="t('board.addTask.pipeline')">
                <PipelinePicker
                  :model-value="pipelineId"
                  :options="selectablePipelines"
                  :none-label="t('describeWork.workspaceDefault')"
                  trigger-class="w-full justify-between"
                  @update:model-value="pipelineId = $event"
                />
              </UFormField>
              <UFormField :label="t('board.addTask.mergePolicy')">
                <RiskPolicyPicker
                  :model-value="riskPolicyId"
                  :options="riskPolicies.presets"
                  :default-policy="riskPolicies.defaultPreset"
                  :none-label="t('describeWork.workspaceDefault')"
                  trigger-class="w-full justify-between"
                  @update:model-value="riskPolicyId = $event"
                />
              </UFormField>
              <UFormField :label="t('board.addTask.modelPreset')">
                <USelect v-model="modelPresetValue" :items="modelPresetItems" class="w-full" />
              </UFormField>
            </div>
          </template>
        </UCollapsible>

        <UButton
          color="neutral"
          variant="link"
          class="p-0"
          icon="i-lucide-paperclip"
          :disabled="!service"
          @click="openFullForm"
        >
          {{ t('describeWork.attachContext') }}
        </UButton>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-end gap-2">
        <p class="w-full text-2xs text-dimmed">{{ t('describeWork.footerHint') }}</p>
        <UButton color="neutral" variant="ghost" @click="open = false">
          {{ t('common.cancel') }}
        </UButton>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="!canSubmit"
          :loading="saving"
          data-testid="describe-work-add"
          @click="submit(false)"
        >
          {{ t('describeWork.add') }}
        </UButton>
        <UButton
          :disabled="!canSubmit || !access.canExecuteRuns.value"
          :loading="saving"
          icon="i-lucide-play"
          data-testid="describe-work-add-start"
          @click="submit(true)"
        >
          {{ t('describeWork.addAndStart') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
