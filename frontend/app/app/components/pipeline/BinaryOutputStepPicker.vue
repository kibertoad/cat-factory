<script setup lang="ts">
// The per-step storage + context selection for a BINARY-OUTPUT kind — a generator whose
// deliverable is binary artifacts stored through a foundational service the org already runs
// (docs/initiatives/binary-output-foundational-storage.md).
//
// Shown on a step whose kind carries the `binary-output` trait, projected onto the workspace
// snapshot as `CustomAgentKind.binaryOutput`. Unlike the variant picker beside it this is NOT
// an override of a default: the selection is REQUIRED — an enabled generator step without one
// is refused at pipeline save AND at run start — so it stays in BOTH interface tiers. Hiding a
// required input in basic mode leaves a step that cannot be saved and no way to find out why.
//
// The storage half offers only services from the RESOLVED catalog that declare the
// `asset-storage` capability, because that is exactly what run admission re-validates against
// at every start/retry/restart. Offering an id from a stale client copy would let a step save
// clean and fail one refusal cycle later.
import { computed } from 'vue'
import { ASSET_STORAGE_CAPABILITY, GENERATION_CONTEXT_CAPABILITY } from '@cat-factory/contracts'
import { binaryOutputPickIssues, type BinaryOutputPickIssue } from '~/utils/binaryOutput'

const props = defineProps<{ index: number }>()

const pipelines = usePipelinesStore()
const catalog = useFoundationalServicesStore()
const { t } = useI18n()

const config = computed(() => pipelines.draftBinaryOutput(props.index))

/** Storage candidates: the capability tag is a REQUIREMENT here, enforced by admission. */
const storageItems = computed(() =>
  catalog.resolved
    .filter((service) => service.capabilities.includes(ASSET_STORAGE_CAPABILITY))
    .map((service) => ({ label: service.name, value: service.id })),
)

/**
 * Context candidates: the WHOLE resolved catalog, with `generation-context`-tagged services
 * ordered first. The tag is conventional and never a filter — any service with a readable
 * contract can inform scope, and admission enforces existence only — so filtering on it here
 * would hide a valid choice the backend would happily accept.
 */
const contextItems = computed(() =>
  [...catalog.resolved]
    .sort((a, b) => {
      const rank = (tags: readonly string[]) =>
        tags.includes(GENERATION_CONTEXT_CAPABILITY) ? 0 : 1
      return rank(a.capabilities) - rank(b.capabilities) || a.name.localeCompare(b.name)
    })
    .map((service) => ({ label: service.name, value: service.id })),
)

const pick = computed(() =>
  binaryOutputPickIssues(config.value, catalog.resolved, catalog.available),
)
function has(issue: BinaryOutputPickIssue): boolean {
  return pick.value.issues.includes(issue)
}

/**
 * Clearing the storage target drops the WHOLE selection, context included: the context ids
 * only mean anything as scope for a generation that has somewhere to land, and a step carrying
 * context alone would persist a shape the backend has no rule for.
 */
function setStorage(storageServiceId: string) {
  const contextServiceIds = config.value?.contextServiceIds
  pipelines.setDraftBinaryOutput(
    props.index,
    storageServiceId
      ? { storageServiceId, ...(contextServiceIds?.length ? { contextServiceIds } : {}) }
      : undefined,
  )
}

function setContext(ids: string[]) {
  const storageServiceId = config.value?.storageServiceId
  if (!storageServiceId) return
  pipelines.setDraftBinaryOutput(props.index, { storageServiceId, contextServiceIds: ids })
}
</script>

<template>
  <div class="ms-6 flex flex-col gap-1.5" data-testid="binary-output-picker">
    <div class="flex items-center gap-2">
      <span class="text-[10px] text-slate-500">{{
        t('pipeline.builder.binaryOutputStorage')
      }}</span>
      <USelect
        class="w-56"
        :model-value="config?.storageServiceId ?? ''"
        :items="storageItems"
        value-key="value"
        size="xs"
        :placeholder="t('pipeline.builder.binaryOutputPlaceholder')"
        :disabled="!storageItems.length"
        data-testid="binary-output-storage-select"
        @update:model-value="setStorage($event)"
      />
    </div>

    <div v-if="config?.storageServiceId" class="flex items-center gap-2">
      <span class="text-[10px] text-slate-500">{{
        t('pipeline.builder.binaryOutputContext')
      }}</span>
      <USelectMenu
        class="w-56"
        multiple
        :model-value="config.contextServiceIds ?? []"
        :items="contextItems"
        value-key="value"
        size="xs"
        :placeholder="t('pipeline.builder.binaryOutputContextPlaceholder')"
        data-testid="binary-output-context-select"
        @update:model-value="setContext($event)"
      />
    </div>

    <!-- Every refusal this step would hit, named where it is fixable. Each is its own line
         with its own remedy: an unreachable catalog is not an empty one, a lost service is not
         an untagged one, and a lost CONTEXT service is not a lost storage target. -->
    <p
      v-if="has('catalog_unavailable')"
      class="text-[10px] text-amber-400"
      data-testid="binary-output-unavailable"
    >
      {{ t('pipeline.builder.binaryOutputUnavailable') }}
    </p>
    <p
      v-else-if="has('no_storage_service')"
      class="text-[10px] text-amber-400"
      data-testid="binary-output-no-storage"
    >
      {{ t('pipeline.builder.binaryOutputNoStorage', { capability: ASSET_STORAGE_CAPABILITY }) }}
    </p>
    <p v-if="has('unknown_service')" class="text-[10px] text-amber-400">
      {{ t('pipeline.builder.binaryOutputMissing') }}
    </p>
    <p v-if="has('not_storage_capable')" class="text-[10px] text-amber-400">
      {{ t('pipeline.builder.binaryOutputNotStorage', { capability: ASSET_STORAGE_CAPABILITY }) }}
    </p>
    <p v-if="has('unknown_context_service')" class="text-[10px] text-amber-400">
      {{
        t('pipeline.builder.binaryOutputContextMissing', {
          ids: pick.unknownContextIds.join(', '),
        })
      }}
    </p>
  </div>
</template>
