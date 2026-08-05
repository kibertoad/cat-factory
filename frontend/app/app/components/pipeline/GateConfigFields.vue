<script setup lang="ts">
// One step's GATE configuration in the pipeline builder: who may clear its human approval gate,
// how many of them must, and the parameters of the registered gate the step's kind runs.
//
// Two halves with deliberately different sources, rendered together because they are one question
// to the author ("how does this checkpoint behave?"):
//
//   - the approval policy is PLATFORM-typed (`StepGateConfig.approvers` / `minApprovals`), so it
//     gets purpose-built controls and the shared rules from `@cat-factory/contracts` decide what
//     counts as configured;
//   - the gate's own parameters are DECLARED BY THE GATE (`gateConfigForms` on the snapshot) and
//     rendered through the shared `DescriptorFields`, so a deployment's gate gets an authoring
//     form from its registration alone and this component learns nothing about it.
//
// Extracted rather than inlined into `PipelineBuilder.vue` for the size rule (split along a seam,
// never grow the ratchet) and because the approver controls need a roster load this component can
// own on its own terms.
import { computed, ref, watch } from 'vue'
import { MAX_GATE_APPROVALS, requiredGateApprovals } from '@cat-factory/contracts'
import type { DescriptorFieldValues, StepGateConfig, WorkspaceRole } from '~/types/domain'
import DescriptorFields from '~/components/common/DescriptorFields.vue'

const props = defineProps<{
  /** The step's index in the draft, for the store patch. */
  index: number
  /** Whether the step carries a human approval gate (the approval half renders only then). */
  gated: boolean
  /** The step's agent kind, for looking up its registered gate's declared parameters. */
  kind: string
}>()

const { t } = useI18n()
const pipelines = usePipelinesStore()
const workspace = useWorkspaceStore()
const members = useWorkspaceMembersStore()

const config = computed<StepGateConfig>(() => pipelines.draftGateConfig(props.index) ?? {})

/**
 * The roles a gate may name. `viewer` is deliberately absent: the workspace RBAC write floor
 * refuses a viewer's resolution before the policy is ever consulted, so offering it would let an
 * author configure an approver who can never approve.
 */
const APPROVER_ROLES: readonly WorkspaceRole[] = ['admin', 'member']

const ROLE_LABEL_KEYS: Record<'admin' | 'member', string> = {
  admin: 'pipeline.gateConfig.roleAdmin',
  member: 'pipeline.gateConfig.roleMember',
}

const requiredApprovals = computed(() => requiredGateApprovals(config.value))

// The roster backs the named-approver picker. Loaded lazily the first time this panel renders (it
// is not on the board snapshot) and only when the caller has a workspace — every resolved role may
// read it, so this is not an admin-only affordance.
const rosterLoaded = ref(false)
watch(
  () => [props.gated, workspace.workspaceId] as const,
  async ([gated, workspaceId]) => {
    if (!gated || !workspaceId || rosterLoaded.value) return
    rosterLoaded.value = true
    await members.load(workspaceId)
  },
  { immediate: true },
)

const memberOptions = computed(() =>
  members.members.map((m) => ({ value: m.userId, label: m.name || m.email || m.userId })),
)

function toggleRole(role: WorkspaceRole, on: boolean) {
  const roles = new Set<WorkspaceRole>(config.value.approvers?.roles ?? [])
  if (on) roles.add(role)
  else roles.delete(role)
  patchApprovers({ roles: [...roles] })
}

function setNamedApprovers(userIds: string[]) {
  patchApprovers({ userIds })
}

/**
 * Write one axis of the approver policy back, keeping the other. Empty arrays are dropped rather
 * than stored: `{ roles: [] }` names nobody, and a policy that names nobody would refuse every
 * approver and park the run forever — so "no rule" has to persist as an ABSENT rule.
 */
function patchApprovers(patch: { roles?: WorkspaceRole[]; userIds?: string[] }) {
  const merged = { ...config.value.approvers, ...patch }
  const approvers: NonNullable<StepGateConfig['approvers']> = {}
  if (merged.roles?.length) approvers.roles = merged.roles
  if (merged.userIds?.length) approvers.userIds = merged.userIds
  pipelines.patchDraftGateConfig(props.index, {
    approvers: Object.keys(approvers).length ? approvers : undefined,
  })
}

function setRequiredApprovals(raw: string) {
  const parsed = Number.parseInt(raw, 10)
  const bounded = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), MAX_GATE_APPROVALS) : 1
  // The store drops a value of 1 (the default), so an author who types the default back persists
  // nothing — the same normalization every other per-step option follows.
  pipelines.patchDraftGateConfig(props.index, { minApprovals: bounded })
}

/** The parameters the registered gate for this step's kind declares, if any. */
const gateFields = computed(
  () => pipelines.gateConfigForms.find((form) => form.kind === props.kind)?.fields,
)

const gateFieldValues = computed<DescriptorFieldValues>({
  get: () => config.value.fields ?? {},
  set: (fields) => pipelines.patchDraftGateConfig(props.index, { fields }),
})
</script>

<template>
  <div v-if="gated || gateFields?.length" class="ms-6 space-y-2" data-testid="gate-config">
    <div v-if="gated" class="space-y-2 rounded-md border border-amber-800/40 bg-amber-950/10 p-2">
      <div class="flex flex-wrap items-center gap-2 text-[10px]">
        <span class="text-slate-500">{{ t('pipeline.gateConfig.approversLabel') }}</span>
        <label
          v-for="role in APPROVER_ROLES"
          :key="role"
          class="flex items-center gap-1 text-slate-400"
        >
          <input
            type="checkbox"
            :checked="config.approvers?.roles?.includes(role) ?? false"
            :data-testid="`gate-approver-role-${role}`"
            @change="toggleRole(role, ($event.target as HTMLInputElement).checked)"
          />
          {{ t(ROLE_LABEL_KEYS[role as 'admin' | 'member']) }}
        </label>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-[10px]">
        <span class="text-slate-500">{{ t('pipeline.gateConfig.namedApproversLabel') }}</span>
        <USelectMenu
          class="w-64"
          multiple
          size="xs"
          value-key="value"
          :items="memberOptions"
          :model-value="config.approvers?.userIds ?? []"
          :placeholder="t('pipeline.gateConfig.namedApproversPlaceholder')"
          data-testid="gate-named-approvers"
          @update:model-value="setNamedApprovers(($event ?? []) as string[])"
        />
      </div>

      <div class="flex flex-wrap items-center gap-2 text-[10px]">
        <label class="text-slate-500" :title="t('pipeline.gateConfig.requiredApprovalsHint')">
          {{ t('pipeline.gateConfig.requiredApprovalsLabel') }}
        </label>
        <input
          :value="requiredApprovals"
          type="number"
          min="1"
          :max="MAX_GATE_APPROVALS"
          step="1"
          class="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-100"
          data-testid="gate-required-approvals"
          @change="setRequiredApprovals(($event.target as HTMLInputElement).value)"
        />
        <span class="text-slate-500">{{ t('pipeline.gateConfig.requiredApprovalsHint') }}</span>
      </div>

      <p v-if="!config.approvers" class="text-[10px] text-slate-500">
        {{ t('pipeline.gateConfig.anyoneHint') }}
      </p>
    </div>

    <!-- The registered gate's OWN parameters, rendered from what it declared. Labels and help are
       the gate's own English (the descriptor-form convention); only the heading is i18n. -->
    <div
      v-if="gateFields?.length"
      class="space-y-2 rounded-md border border-slate-800 bg-slate-900/40 p-2"
    >
      <p class="text-[10px] text-slate-500">{{ t('pipeline.gateConfig.gateParametersLabel') }}</p>
      <DescriptorFields
        v-model="gateFieldValues"
        :fields="gateFields"
        testid-prefix="gate-parameter"
      />
    </div>
  </div>
</template>
