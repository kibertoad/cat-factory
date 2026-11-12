<script setup lang="ts">
import { computed, ref } from 'vue'
import type { OutcomeStoragePolicy, OutcomeStoragePolicyView } from '@cat-factory/contracts'
import { formatBytes } from '~/utils/projectView'
import { selectNoneItem, selectNoneModel } from '~/utils/selectNone'

// The outcome-storage tiers this board reads for a project: the account's (set at the
// account), the board's own and the project's, each shown as set or inherited, with the policy
// they resolve to. The board's tier and the project's are editable here.

const props = defineProps<{ projectId: string; view: OutcomeStoragePolicyView }>()
const { t } = useI18n()
const projectViews = useProjectViewsStore()
const errors = usePipelineErrorToast()

type Tier = 'workspace' | 'project'
const saving = ref<Tier | null>(null)

const drafts = ref<Record<Tier, { inlineKb: number | undefined; offload: string }>>({
  workspace: draftOf(props.view.workspace),
  project: draftOf(props.view.project ?? null),
})

function draftOf(policy: OutcomeStoragePolicy | null) {
  return {
    inlineKb:
      policy?.inlineMaxBytes !== undefined ? Math.round(policy.inlineMaxBytes / 1024) : undefined,
    offload: policy?.offload ?? '',
  }
}

const offloadItems = computed(() => [
  selectNoneItem(t('projects.view.storage.inherit')),
  { label: t('projects.view.storage.offload.enabled'), value: 'enabled' },
  { label: t('projects.view.storage.offload.disabled'), value: 'disabled' },
])

const offloadModels = {
  workspace: selectNoneModel(
    () => drafts.value.workspace.offload,
    (value) => (drafts.value.workspace.offload = value),
  ),
  project: selectNoneModel(
    () => drafts.value.project.offload,
    (value) => (drafts.value.project.offload = value),
  ),
}

function describe(policy: OutcomeStoragePolicy | null | undefined): string {
  if (!policy) return t('projects.view.storage.inherits')
  const parts: string[] = []
  if (policy.inlineMaxBytes !== undefined) {
    parts.push(t('projects.view.storage.inlineUpTo', { size: formatBytes(policy.inlineMaxBytes) }))
  }
  if (policy.offload) parts.push(t(`projects.view.storage.offload.${policy.offload}`))
  return parts.join(', ')
}

async function save(tier: Tier) {
  const draft = drafts.value[tier]
  const policy: OutcomeStoragePolicy = {
    ...(draft.inlineKb !== undefined ? { inlineMaxBytes: draft.inlineKb * 1024 } : {}),
    ...(draft.offload === 'enabled' || draft.offload === 'disabled'
      ? { offload: draft.offload }
      : {}),
  }
  saving.value = tier
  try {
    await projectViews.setPolicy(props.projectId, tier, policy)
  } catch (e) {
    errors.present(e, 'projects.view.storage.saveFailed')
  } finally {
    saving.value = null
  }
}
</script>

<template>
  <div class="space-y-3" data-testid="project-storage">
    <p class="text-sm" data-testid="project-storage-effective">
      {{
        t('projects.view.storage.effective', {
          size: formatBytes(view.effective.inlineMaxBytes),
          offload: t(`projects.view.storage.offload.${view.effective.offload}`),
        })
      }}
    </p>
    <div class="rounded-lg border border-default p-3">
      <p class="text-sm font-medium">{{ t('projects.view.storage.tier.account') }}</p>
      <p class="text-xs text-muted">{{ describe(view.account) }}</p>
      <p class="mt-1 text-2xs text-dimmed">{{ t('projects.view.storage.accountHint') }}</p>
    </div>
    <div
      v-for="tier in ['workspace', 'project'] as const"
      :key="tier"
      class="rounded-lg border border-default p-3"
      :data-testid="`project-storage-${tier}`"
    >
      <p class="text-sm font-medium">{{ t(`projects.view.storage.tier.${tier}`) }}</p>
      <p class="text-xs text-muted">
        {{ describe(tier === 'workspace' ? view.workspace : view.project) }}
      </p>
      <div class="mt-2 flex flex-wrap items-end gap-2">
        <UFormField :label="t('projects.view.storage.inlineKb')">
          <UInputNumber
            v-model="drafts[tier].inlineKb"
            :min="0"
            :max="1953"
            :placeholder="t('projects.view.storage.inherit')"
          />
        </UFormField>
        <UFormField :label="t('projects.view.storage.offloadLabel')">
          <USelect v-model="offloadModels[tier].value" :items="offloadItems" class="w-48" />
        </UFormField>
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          :loading="saving === tier"
          @click="save(tier)"
        >
          {{ t('projects.view.storage.save') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
