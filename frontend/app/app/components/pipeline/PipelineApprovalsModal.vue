<script setup lang="ts">
// A BUILT-IN pipeline's human approval checkpoints, edited in place: the one change a built-in
// accepts, so a board can add oversight without cloning the built-in off its catalog updates.
//
// The chain is shown and cannot be edited, and the checkpoints the catalog ships are locked on,
// because only a clone may drop one. Holds its own copy of the gates and approver policies rather
// than the builder's draft, so opening it never clobbers a pipeline someone is composing.
import { computed, ref } from 'vue'
import type { StepGateConfig } from '@cat-factory/contracts'
import type { Pipeline } from '~/types/domain'
import AppModal from '~/components/common/AppModal.vue'
import AgentKindIcon from '~/components/pipeline/AgentKindIcon.vue'
import GateConfigFields from '~/components/pipeline/GateConfigFields.vue'
import StepCheckpointControl from '~/components/pipeline/StepCheckpointControl.vue'
import { agentKindMeta } from '~/utils/catalog'
import { showOverrideField } from '~/utils/uiMode'
import {
  approvalPolicyOf,
  foldCompanionUnits,
  patchedGateConfig,
  type PipelineUnit,
} from '~/utils/pipelineCheckpoints'

const props = defineProps<{ pipeline: Pipeline }>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const pipelines = usePipelinesStore()
const uiMode = useUiModeStore()
const actionToast = useActionToast()
const { present } = usePipelineErrorToast()

const kinds = props.pipeline.agentKinds
const gates = ref(kinds.map((_, i) => props.pipeline.gates?.[i] === true))
// The approval half only: a gate's own parameters belong to the built-in's structure.
const policies = ref<(StepGateConfig | null)[]>(
  kinds.map((_, i) => approvalPolicyOf(props.pipeline.stepOptions?.[i])),
)
const shipped = computed(() => pipelines.shippedCheckpoints(props.pipeline))
const units = computed(() => foldCompanionUnits(kinds))
const saving = ref(false)

function label(index: number | null): string {
  return index === null ? '' : agentKindMeta(kinds[index] ?? '').label
}

function setCheckpoints(unit: PipelineUnit, next: { producer: boolean; companion: boolean }) {
  gates.value[unit.index] = next.producer
  if (unit.companionIndex !== null) gates.value[unit.companionIndex] = next.companion
}

/** The steps of a row whose checkpoint is on, for the approver fields under it. */
function gatedSteps(unit: PipelineUnit): number[] {
  return [unit.index, unit.companionIndex].filter(
    (index): index is number => index !== null && gates.value[index] === true,
  )
}

function patchPolicy(index: number, patch: Partial<StepGateConfig>) {
  policies.value[index] =
    patchedGateConfig({ gateConfig: policies.value[index] ?? {} }, patch)?.gateConfig ?? null
}

async function save() {
  saving.value = true
  try {
    await pipelines.saveApprovals(props.pipeline.id, {
      gates: gates.value,
      policies: policies.value.map((policy, i) => (gates.value[i] ? policy : null)),
    })
    actionToast.success('pipeline.approvals.toast.saved', {
      params: { name: props.pipeline.name },
    })
    open.value = false
  } catch (error) {
    present(error, 'pipeline.approvals.toast.saveFailed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppModal
    v-model:open="open"
    size="form"
    :title="t('pipeline.approvals.title', { name: pipeline.name })"
    :description="t('pipeline.approvals.description')"
  >
    <template #body>
      <ol class="space-y-2" data-testid="pipeline-approvals">
        <li
          v-for="unit in units"
          :key="unit.index"
          class="space-y-2"
          :class="{ 'opacity-50': pipeline.enabled?.[unit.index] === false }"
          :data-agent-kind="unit.kind"
        >
          <div class="flex items-center gap-2">
            <AgentKindIcon :kind="unit.kind" show-label />
            <span v-if="unit.companionIndex !== null" class="text-xs text-dimmed">
              {{ t('pipeline.approvals.reviewedBy', { companion: label(unit.companionIndex) }) }}
            </span>
            <span class="flex-1" />
            <StepCheckpointControl
              :producer-gated="gates[unit.index] === true"
              :companion-gated="
                unit.companionIndex === null ? null : gates[unit.companionIndex] === true
              "
              :producer-label="label(unit.index)"
              :companion-label="label(unit.companionIndex)"
              :locked-producer="shipped[unit.index] === true"
              :locked-companion="
                unit.companionIndex !== null && shipped[unit.companionIndex] === true
              "
              @update="setCheckpoints(unit, $event)"
            />
          </div>
          <template v-for="index in gatedSteps(unit)" :key="index">
            <GateConfigFields
              v-if="showOverrideField(uiMode.isAdvanced, policies[index])"
              class="ms-6"
              :config="policies[index] ?? {}"
              gated
              :kind="kinds[index] ?? ''"
              :show-parameters="false"
              @patch="patchPolicy(index, $event)"
            />
          </template>
        </li>
      </ol>
      <p class="mt-3 text-xs text-dimmed">{{ t('pipeline.approvals.lockedHint') }}</p>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
          {{ t('common.cancel') }}
        </UButton>
        <UButton :loading="saving" data-testid="pipeline-approvals-save" @click="save">
          {{ t('common.save') }}
        </UButton>
      </div>
    </template>
  </AppModal>
</template>
