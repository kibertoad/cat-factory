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
//
// The GENERATIVE half answers the other question — what MAKES the artifacts — and its candidates
// come from a different place: the integrations are registered in the deployment's CODE, so they
// ride the workspace snapshot (`binaryGenerators`) rather than a catalog read. Both halves are
// offered here because a step needs both to work, and only this surface can tell a human that the
// content types it promises to deliver are not covered by anything it selected.
import { computed, ref, watch } from 'vue'
import {
  ASSET_STORAGE_CAPABILITY,
  GENERATION_CONTEXT_CAPABILITY,
  isBinaryModality,
  type BinaryModality,
  type BinaryOutputConfig,
} from '@cat-factory/contracts'
import { binaryOutputPickIssues, type BinaryOutputPickIssue } from '~/utils/binaryOutput'
import { parseMediaTypeRequirement, sameFormats } from './BinaryOutputStepPicker.logic'

const props = defineProps<{ index: number }>()

const pipelines = usePipelinesStore()
const catalog = useFoundationalServicesStore()
const agents = useAgentsStore()
const { t } = useI18n()

/**
 * The content-type vocabulary, as STATIC literal `t()` keys — one per member, never a key
 * assembled at runtime, so the typed-message-key check covers them (the standing i18n rule for
 * an enum-keyed set).
 */
const MODALITY_LABELS: Record<BinaryModality, () => string> = {
  image: () => t('pipeline.builder.binaryOutputModality.image'),
  audio: () => t('pipeline.builder.binaryOutputModality.audio'),
  video: () => t('pipeline.builder.binaryOutputModality.video'),
  '3d-model': () => t('pipeline.builder.binaryOutputModality.3d-model'),
  '3d-scene': () => t('pipeline.builder.binaryOutputModality.3d-scene'),
  document: () => t('pipeline.builder.binaryOutputModality.document'),
}
const MODALITY_ORDER: BinaryModality[] = [
  'image',
  'audio',
  'video',
  '3d-model',
  '3d-scene',
  'document',
]
/**
 * A content type in the reader's language, INCLUDING one this build no longer defines.
 *
 * The `Record` above is exhaustive over the union, so the lookup looks total — and is not, because
 * `modalities` is PERSISTED: a step saved under an earlier vocabulary carries a member that has
 * since been retired (`3d` did exactly that when it split into `3d-model` and `3d-scene`). Such a
 * value is by construction uncovered by every registered integration, so it lands in the
 * `modality_uncovered` warning below — the one line whose job is to tell someone what to re-pick —
 * and a bare `MODALITY_LABELS[modality]()` there is a `TypeError` that takes the whole builder
 * down, on exactly the surface the fix has to be made on.
 *
 * The guard is `isBinaryModality` (contracts, derived from the picklist itself) rather than an
 * optional call on the `Record`, so the narrowing says WHY it is needed and a member added to the
 * vocabulary is known here without anyone remembering to widen anything.
 *
 * The retired value is NAMED rather than silently dropped or guessed at a current member: nothing
 * here knows which one was meant, and a modality quietly missing from the list reads as a step
 * that never required it. This is the standing "absent is not zero" rule at the one place the
 * typed-key check cannot reach — the key is static, but the LOOKUP is a runtime value.
 */
function modalityLabel(modality: BinaryModality): string {
  return isBinaryModality(modality)
    ? MODALITY_LABELS[modality]()
    : t('pipeline.builder.binaryOutputModalityRetired', { modality: String(modality) })
}

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

/**
 * Generative candidates: every integration the deployment registered, labelled with what it
 * produces so the choice is legible without cross-referencing. No filter — unlike the storage
 * half there is no capability to require, and any registered integration is one admission accepts.
 */
const generatorItems = computed(() =>
  agents.binaryGenerators.map((generator) => ({
    label: `${generator.name} — ${generator.modalities.map(modalityLabel).join(', ')}`,
    value: generator.id,
  })),
)

const modalityItems = computed(() =>
  MODALITY_ORDER.map((modality) => ({ label: modalityLabel(modality), value: modality })),
)

const pick = computed(() =>
  binaryOutputPickIssues(
    config.value,
    catalog.resolved,
    catalog.available,
    agents.binaryGenerators,
    agents.binaryGeneratorsUnavailable,
  ),
)
function has(issue: BinaryOutputPickIssue): boolean {
  return pick.value.issues.includes(issue)
}

/**
 * Clearing the storage target drops the WHOLE selection — context and generative halves included:
 * every other id only means anything as part of a generation that has somewhere to land, and a
 * step carrying them alone would persist a shape the backend has no rule for. Setting a target
 * carries the rest through, so re-pointing storage is not a silent reset of the other two.
 */
function setStorage(storageServiceId: string | undefined) {
  const current = config.value
  pipelines.setDraftBinaryOutput(
    props.index,
    storageServiceId ? { ...current, storageServiceId } : undefined,
  )
}

/**
 * Patch one half of the selection, carrying the others through. Every setter but `setStorage`
 * goes via here so a change to one half can never silently drop another — the store rebuilds the
 * whole `binaryOutput` bag from what it is handed, so an omitted field is a deletion.
 */
function patch(fields: Partial<BinaryOutputConfig>) {
  const current = config.value
  const storageServiceId = current?.storageServiceId
  if (!storageServiceId) return
  pipelines.setDraftBinaryOutput(props.index, { ...current, storageServiceId, ...fields })
}

function setContext(ids: string[]) {
  patch({ contextServiceIds: ids })
}

function setGenerators(ids: string[]) {
  patch({ generatorIds: ids })
}

function setModalities(modalities: BinaryModality[]) {
  patch({ modalities })
}

/**
 * The FORMAT requirement is free text, not a pick from the selection, and that is deliberate: the
 * whole reason a step states a format is that the selected integrations might not cover it, and a
 * picker offering only what they declare could never express the requirement whose violation this
 * feature exists to catch. What the selection declares is offered as a HINT below instead.
 *
 * Held in a local ref rather than bound straight to the config so a half-typed `model/` is not
 * parsed on every keystroke, and so the normalisation the field applies is VISIBLE — the text
 * snaps back to what was stored.
 */
const mediaTypeText = ref((config.value?.mediaTypes ?? []).join(', '))

/**
 * Entries that are not a `type/subtype` at all, named rather than silently dropped — a
 * requirement someone typed and the step does not carry is exactly the "absent reads as fine"
 * failure the rest of this surface is built to avoid.
 */
const unusableMediaTypes = ref<string[]>([])

/**
 * What this field last wrote, so the watch below can tell its OWN patch from a config that
 * changed underneath it.
 */
let lastWritten: string[] | undefined = config.value?.mediaTypes

watch(
  () => config.value?.mediaTypes,
  (mediaTypes) => {
    mediaTypeText.value = (mediaTypes ?? []).join(', ')
    // The rejected entries belong to the TEXT that was typed, so they outlive this field's own
    // patch — clearing them on every config change would erase the warning in the same tick it
    // was raised, since accepting `image/png` out of `foo, image/png` is itself a patch. Any
    // OTHER route to a new value (the picker rebound to another step, the draft reloaded,
    // storage cleared and the bag dropped) is describing text that no longer exists, and a
    // warning about entries nobody can see is the same "absent reads as fine" failure pointed
    // the other way.
    if (!sameFormats(mediaTypes, lastWritten)) unusableMediaTypes.value = []
    lastWritten = mediaTypes
  },
)

function setMediaTypes(text: string) {
  const { usable, unusable } = parseMediaTypeRequirement(text)
  unusableMediaTypes.value = unusable
  mediaTypeText.value = usable.join(', ')
  // Claimed BEFORE the patch, so the watch above reads this write as its own however it is
  // flushed, and the entries just rejected survive to be rendered.
  lastWritten = usable.length ? usable : undefined
  patch({ mediaTypes: lastWritten })
}

/**
 * The overlap, as `content type: id, id` per shared content type.
 *
 * Assembled here rather than in the read model because it needs `modalityLabel`, and it renders a
 * RETIRED content type through the same guard every other line does: a step saved under an older
 * vocabulary can hold one, and two integrations serving it would otherwise put a `TypeError` on
 * the surface where the re-pick has to be made.
 */
const overlapSummary = computed(() =>
  pick.value.generatorOverlaps
    .map((overlap) => `${modalityLabel(overlap.modality)}: ${overlap.generatorIds.join(', ')}`)
    .join('; '),
)

/** What the SELECTED integrations say they emit — the discoverable half of the free-text field. */
const declaredFormats = computed(() => {
  const byId = new Map(agents.binaryGenerators.map((generator) => [generator.id, generator]))
  const selected = (config.value?.generatorIds ?? []).flatMap((id) => byId.get(id) ?? [])
  return [...new Set(selected.flatMap((generator) => generator.mediaTypes ?? []))]
})
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

    <div v-if="config?.storageServiceId" class="flex items-center gap-2">
      <span class="text-[10px] text-slate-500">{{
        t('pipeline.builder.binaryOutputGenerators')
      }}</span>
      <USelectMenu
        class="w-56"
        multiple
        :model-value="config.generatorIds ?? []"
        :items="generatorItems"
        value-key="value"
        size="xs"
        :placeholder="t('pipeline.builder.binaryOutputGeneratorsPlaceholder')"
        :disabled="!generatorItems.length"
        data-testid="binary-output-generator-select"
        @update:model-value="setGenerators($event)"
      />
    </div>

    <div v-if="config?.storageServiceId" class="flex items-center gap-2">
      <span class="text-[10px] text-slate-500">{{
        t('pipeline.builder.binaryOutputModalities')
      }}</span>
      <USelectMenu
        class="w-56"
        multiple
        :model-value="config.modalities ?? []"
        :items="modalityItems"
        value-key="value"
        size="xs"
        :placeholder="t('pipeline.builder.binaryOutputModalitiesPlaceholder')"
        data-testid="binary-output-modality-select"
        @update:model-value="setModalities($event)"
      />
    </div>

    <!-- The FORMAT requirement, one notch finer than the content types above it and shown right
         under them. Both tiers: like the rest of this picker it is not an override of a default —
         a format nobody stated is a format the run does not check. -->
    <div v-if="config?.storageServiceId" class="flex items-center gap-2">
      <span class="text-[10px] text-slate-500">{{
        t('pipeline.builder.binaryOutputMediaTypes')
      }}</span>
      <UInput
        class="w-56"
        :model-value="mediaTypeText"
        size="xs"
        :placeholder="t('pipeline.builder.binaryOutputMediaTypesPlaceholder')"
        data-testid="binary-output-media-type-input"
        @update:model-value="mediaTypeText = String($event)"
        @change="setMediaTypes(mediaTypeText)"
      />
    </div>
    <p
      v-if="config?.storageServiceId && declaredFormats.length"
      class="ms-1 text-[10px] text-slate-500"
      data-testid="binary-output-declared-formats"
    >
      {{
        t('pipeline.builder.binaryOutputDeclaredFormats', { formats: declaredFormats.join(', ') })
      }}
    </p>

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
    <!-- The generative refusals stay their own lines, and their remedies point somewhere else
         entirely: an unregistered integration is fixed in the DEPLOYMENT'S BUILD, not in this
         workspace, which is the whole reason the backend keeps the two reason codes apart.
         Unless the set could not be READ, in which case none of them is a claim anyone can make:
         it says so and stops, exactly as run admission does. -->
    <p
      v-if="has('generators_unavailable')"
      class="text-[10px] text-amber-400"
      data-testid="binary-output-generators-unavailable"
    >
      {{ t('pipeline.builder.binaryOutputGeneratorsUnavailable') }}
    </p>
    <p
      v-if="has('unknown_generator')"
      class="text-[10px] text-amber-400"
      data-testid="binary-output-unknown-generator"
    >
      {{
        t('pipeline.builder.binaryOutputGeneratorMissing', {
          ids: pick.unknownGeneratorIds.join(', '),
        })
      }}
    </p>
    <p
      v-if="has('modality_uncovered')"
      class="text-[10px] text-amber-400"
      data-testid="binary-output-modality-uncovered"
    >
      {{
        t('pipeline.builder.binaryOutputModalityUncovered', {
          modalities: pick.uncoveredModalities.map(modalityLabel).join(', '),
        })
      }}
    </p>
    <p
      v-if="has('media_type_uncovered')"
      class="text-[10px] text-amber-400"
      data-testid="binary-output-media-type-uncovered"
    >
      {{
        t('pipeline.builder.binaryOutputMediaTypeUncovered', {
          formats: pick.uncoveredMediaTypes.join(', '),
        })
      }}
    </p>
    <!-- ADVISORY, and styled apart from every line above it: the step starts. The backend admits
         a format requirement it could not judge, because a generator that declares no formats has
         said only that its formats are unknown — and a surface that dressed that up as a refusal
         would send someone editing a selection that is fine. -->
    <p
      v-if="has('media_type_unverifiable')"
      class="text-[10px] text-slate-500"
      data-testid="binary-output-media-type-unverifiable"
    >
      {{
        t('pipeline.builder.binaryOutputMediaTypeUnverifiable', {
          formats: pick.unverifiableMediaTypes.join(', '),
        })
      }}
    </p>
    <!-- ADVISORY, and grouped with the line above it rather than the refusals: selecting two
         producers of one content type is the reason the selection is a list, and nothing about
         the step is wrong. What it costs is a decision nobody wrote down, so the remedy this
         line carries is the step's own prompt, which is the field right beside it. -->
    <p
      v-if="has('generator_overlap')"
      class="text-[10px] text-slate-500"
      data-testid="binary-output-generator-overlap"
    >
      {{ t('pipeline.builder.binaryOutputGeneratorOverlap', { overlaps: overlapSummary }) }}
    </p>
    <p
      v-if="unusableMediaTypes.length"
      class="text-[10px] text-amber-400"
      data-testid="binary-output-media-type-unusable"
    >
      {{
        t('pipeline.builder.binaryOutputMediaTypeUnusable', {
          entries: unusableMediaTypes.join(', '),
        })
      }}
    </p>
  </div>
</template>
