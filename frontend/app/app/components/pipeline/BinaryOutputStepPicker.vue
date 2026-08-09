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
  isBinaryGeneratorCapability,
  isBinaryModality,
  type BinaryGenerationOptions,
  type BinaryGeneratorCapability,
  type BinaryModality,
  type BinaryOutputConfig,
  type BinaryValueOption,
  type ConflictingOutputSizeOption,
} from '@cat-factory/contracts'
import { binaryOutputPickIssues, type BinaryOutputPickIssue } from '~/utils/binaryOutput'
import {
  formatExtent,
  formatReferenceImages,
  generationControlOffer,
  parseExtent,
  parseMediaTypeRequirement,
  parseReferenceImages,
  sameFormats,
} from './BinaryOutputStepPicker.logic'

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

/**
 * The capability vocabulary, as STATIC literal `t()` keys: one per member, never assembled at
 * runtime, so the typed-message-key check covers them (the standing rule for an enum-keyed set).
 */
const CAPABILITY_LABELS: Record<BinaryGeneratorCapability, () => string> = {
  'reference-image': () => t('pipeline.builder.binaryCapability.reference-image'),
  'multi-reference': () => t('pipeline.builder.binaryCapability.multi-reference'),
  'instruction-edit': () => t('pipeline.builder.binaryCapability.instruction-edit'),
  'mask-edit': () => t('pipeline.builder.binaryCapability.mask-edit'),
  'negative-prompt': () => t('pipeline.builder.binaryCapability.negative-prompt'),
  seed: () => t('pipeline.builder.binaryCapability.seed'),
  'aspect-ratio': () => t('pipeline.builder.binaryCapability.aspect-ratio'),
  'exact-size': () => t('pipeline.builder.binaryCapability.exact-size'),
  'candidate-batch': () => t('pipeline.builder.binaryCapability.candidate-batch'),
  upscale: () => t('pipeline.builder.binaryCapability.upscale'),
  'transparent-background': () => t('pipeline.builder.binaryCapability.transparent-background'),
  tileable: () => t('pipeline.builder.binaryCapability.tileable'),
}

/**
 * The options that restate a delivered size, named by the FIELD LABEL each one carries in this
 * form, so the refusal points at a control the reader can see. Static literal keys, the
 * enum-keyed-set rule again; the union is closed here (not a persisted vocabulary a stale step
 * could carry a retired member of), so the lookup needs no membership guard.
 */
const SIZE_CONFLICT_LABELS: Record<ConflictingOutputSizeOption, () => string> = {
  aspectRatio: () => t('pipeline.builder.binaryAspectRatio'),
  upscale: () => t('pipeline.builder.binaryUpscale'),
}

/**
 * A value option named by the FIELD LABEL it carries on this form, so a refusal about a value
 * points at the control holding it. Closed and compiled-against on both sides of the wire (unlike
 * a capability, which a newer mothership can name), so the lookup needs no membership guard.
 */
const VALUE_OPTION_LABELS: Record<BinaryValueOption, () => string> = {
  aspectRatio: () => t('pipeline.builder.binaryAspectRatio'),
  outputSize: () => t('pipeline.builder.binaryOutputSize'),
  upscale: () => t('pipeline.builder.binaryUpscale'),
}

/**
 * A capability in the reader's language, INCLUDING one this build does not define.
 *
 * The `Record` is exhaustive over the union and the lookup is still not total: the integrations
 * ride the workspace snapshot, and on a mothership-mode deployment that snapshot is served by a
 * process which may be a build AHEAD of this one. A bare lookup on such a value is a `TypeError`
 * on the surface where the selection is made. Same guard, same reason, as `modalityLabel`.
 */
function capabilityLabel(capability: BinaryGeneratorCapability): string {
  return isBinaryGeneratorCapability(capability)
    ? CAPABILITY_LABELS[capability]()
    : t('pipeline.builder.binaryCapabilityUnknown', { capability: String(capability) })
}

const generation = computed<BinaryGenerationOptions>(() => config.value?.generation ?? {})

/** The registered integrations this step has selected, in the order the step names them. */
const selectedGenerators = computed(() => {
  const byId = new Map(agents.binaryGenerators.map((generator) => [generator.id, generator]))
  return (config.value?.generatorIds ?? []).flatMap((id) => byId.get(id) ?? [])
})

/**
 * Whether to OFFER the control an option belongs to. The rule itself is pure and lives in the
 * logic sibling, where its three cases (undeclared, declared, already-set) are testable without
 * mounting this component.
 */
const offers = computed(() => generationControlOffer(selectedGenerators.value, generation.value))

/** The edit modes, as static literal keys: the enum-keyed-set rule again. */
const editModeItems = computed(() => [
  { label: t('pipeline.builder.binaryEditModeInstruction'), value: 'instruction' },
  { label: t('pipeline.builder.binaryEditModeMask'), value: 'mask' },
])

/**
 * Patch ONE generation option, dropping it when it is cleared.
 *
 * A cleared option is REMOVED rather than stored as an empty value, because the two are different
 * requirements: an absent `seed` means the step does not pin one, while `seed: 0` is a pinned
 * seed of zero, and admission judges the option's PRESENCE.
 */
function setGeneration(fields: Partial<BinaryGenerationOptions>) {
  const next: Record<string, unknown> = { ...generation.value, ...fields }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      delete next[key]
    }
  }
  patch({
    generation: Object.keys(next).length > 0 ? (next as BinaryGenerationOptions) : undefined,
  })
}

/**
 * The size fields' own text, held locally like {@link referenceText} and for the same reason: a
 * control has to render what is being typed, and the step must not store what is being typed.
 *
 * The pair is ONE requirement, so it reaches the step only once BOTH halves read as a pixel
 * extent. Writing the unset half as 0 while the first number is typed would store a value the
 * schema refuses (the minimum is 1), which makes the step unsaveable behind an opaque validation
 * error and renders "0" back into a field nobody touched. A half-entered pair is instead simply
 * not stored, and {@link outputSizeIncomplete} says so where it is being typed.
 */
const outputSizeText = ref({
  width: formatExtent(config.value?.generation?.outputSize?.width),
  height: formatExtent(config.value?.generation?.outputSize?.height),
})

watch(
  () => config.value?.generation?.outputSize,
  (size) => {
    outputSizeText.value = { width: formatExtent(size?.width), height: formatExtent(size?.height) }
  },
)

/** One half is filled and the other is not, so nothing is stored and the composer is told why. */
const outputSizeIncomplete = computed(() => {
  const filled = [outputSizeText.value.width, outputSizeText.value.height].filter(
    (half) => half.trim() !== '',
  )
  return filled.length === 1
})

/** Patch ONE half of the exact output size, committing the pair only once both halves read. */
function setOutputSize(axis: 'width' | 'height', raw: string) {
  outputSizeText.value = { ...outputSizeText.value, [axis]: raw }
  const width = parseExtent(outputSizeText.value.width)
  const height = parseExtent(outputSizeText.value.height)
  setGeneration({ outputSize: width !== null && height !== null ? { width, height } : undefined })
}

/** The reference-image field's text, and the lines it refused (see `parseReferenceImages`). */
const referenceText = ref(formatReferenceImages(config.value?.generation?.referenceImages))
const unusableReferences = ref<string[]>([])

watch(
  () => config.value?.generation?.referenceImages,
  (references) => {
    referenceText.value = formatReferenceImages(references)
  },
)

function setReferences(text: string) {
  const { usable, unusable } = parseReferenceImages(text)
  unusableReferences.value = unusable
  referenceText.value = formatReferenceImages(usable)
  setGeneration({ referenceImages: usable })
}

/**
 * Turn the candidate comparison on or off. Off DROPS the whole bag rather than storing a disabled
 * one: the presence of `comparison` is what the engine reads, so a saved "off" object would be a
 * configuration describing a behaviour the run does not have.
 */
function setComparison(on: boolean) {
  patch({ comparison: on ? (config.value?.comparison ?? {}) : undefined })
}

function setPerGenerator(value: number) {
  const current = config.value?.comparison
  if (!current) return
  patch({ comparison: { ...current, perGenerator: value } })
}

function setMultiSelect(on: boolean) {
  const current = config.value?.comparison
  if (!current) return
  patch({
    comparison: on ? { ...current, multiSelect: true } : { perGenerator: current.perGenerator },
  })
}

/**
 * Whether the step could actually produce a comparison: the SAME rule
 * `assertComparableCandidates` refuses at save, stated here where it is fixable. Without it a
 * step saves clean, starts, and keeps its only candidate without ever asking anyone.
 */
const comparisonUnreachable = computed(() => {
  const comparison = config.value?.comparison
  if (!comparison) return false
  if ((comparison.perGenerator ?? 1) > 1) return false
  return (config.value?.generatorIds?.length ?? 0) < 2
})

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

    <!-- GENERATION OPTIONS. Each control is gated on a capability the selected integrations
         declare, so a step cannot ask for a reference image from an endpoint that takes no image
         input. While nothing has DECLARED its capabilities every control stays offered and the
         advisory line below says the support is unconfirmed: hiding one would be a claim about a
         vendor's API that nobody established. Both tiers, like the rest of this picker: an
         option nobody stated is an option the run does not apply. -->
    <template v-if="config?.storageServiceId">
      <div v-if="offers('reference-image')" class="flex items-start gap-2">
        <span class="mt-1 text-[10px] text-slate-500">{{
          t('pipeline.builder.binaryReferenceImages')
        }}</span>
        <UTextarea
          class="w-56"
          :rows="2"
          size="xs"
          :model-value="referenceText"
          :placeholder="t('pipeline.builder.binaryReferenceImagesPlaceholder')"
          data-testid="binary-output-reference-input"
          @update:model-value="referenceText = String($event)"
          @change="setReferences(referenceText)"
        />
      </div>
      <p
        v-if="unusableReferences.length"
        class="ms-1 text-[10px] text-amber-400"
        data-testid="binary-output-reference-unusable"
      >
        {{
          t('pipeline.builder.binaryReferenceImagesUnusable', {
            entries: unusableReferences.join('; '),
          })
        }}
      </p>

      <div v-if="offers('instruction-edit') || offers('mask-edit')" class="flex items-center gap-2">
        <span class="text-[10px] text-slate-500">{{ t('pipeline.builder.binaryEditMode') }}</span>
        <USelect
          class="w-56"
          size="xs"
          :model-value="generation.edit?.mode ?? ''"
          :items="editModeItems"
          value-key="value"
          :placeholder="t('pipeline.builder.binaryEditModeNone')"
          data-testid="binary-output-edit-mode"
          @update:model-value="
            setGeneration({
              edit: $event
                ? { ...generation.edit, mode: $event as 'instruction' | 'mask' }
                : undefined,
            })
          "
        />
      </div>
      <div v-if="generation.edit" class="flex items-center gap-2">
        <span class="text-[10px] text-slate-500">{{
          t('pipeline.builder.binaryEditInstruction')
        }}</span>
        <UInput
          class="w-56"
          size="xs"
          :model-value="generation.edit.instruction ?? ''"
          :placeholder="t('pipeline.builder.binaryEditInstructionPlaceholder')"
          data-testid="binary-output-edit-instruction"
          @change="
            setGeneration({
              edit: { ...generation.edit!, instruction: ($event.target as HTMLInputElement).value },
            })
          "
        />
      </div>

      <div v-if="offers('negative-prompt')" class="flex items-center gap-2">
        <span class="text-[10px] text-slate-500">{{
          t('pipeline.builder.binaryNegativePrompt')
        }}</span>
        <UInput
          class="w-56"
          size="xs"
          :model-value="generation.negativePrompt ?? ''"
          :placeholder="t('pipeline.builder.binaryNegativePromptPlaceholder')"
          data-testid="binary-output-negative-prompt"
          @change="
            setGeneration({ negativePrompt: ($event.target as HTMLInputElement).value.trim() })
          "
        />
      </div>

      <div v-if="offers('aspect-ratio')" class="flex items-center gap-2">
        <span class="text-[10px] text-slate-500">{{
          t('pipeline.builder.binaryAspectRatio')
        }}</span>
        <UInput
          class="w-56"
          size="xs"
          :model-value="generation.aspectRatio ?? ''"
          :placeholder="t('pipeline.builder.binaryAspectRatioPlaceholder')"
          data-testid="binary-output-aspect-ratio"
          @change="setGeneration({ aspectRatio: ($event.target as HTMLInputElement).value.trim() })"
        />
      </div>

      <!-- Two numbers rather than one free-text "WxH": the requirement is a pair of integers and
           a parser over a string is a second place for it to be wrong. Offered only where an
           integration declares `exact-size`, because a bucketed endpoint cannot be asked for
           dimensions at all and a control implying otherwise is the misconception this axis
           exists to remove. -->
      <div v-if="offers('exact-size')" class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <span class="text-[10px] text-slate-500">{{
            t('pipeline.builder.binaryOutputSize')
          }}</span>
          <UInput
            class="w-24"
            type="number"
            size="xs"
            :model-value="outputSizeText.width"
            :placeholder="t('pipeline.builder.binaryOutputSizeWidth')"
            data-testid="binary-output-size-width"
            @change="setOutputSize('width', ($event.target as HTMLInputElement).value)"
          />
          <span class="text-[10px] text-slate-500">×</span>
          <UInput
            class="w-24"
            type="number"
            size="xs"
            :model-value="outputSizeText.height"
            :placeholder="t('pipeline.builder.binaryOutputSizeHeight')"
            data-testid="binary-output-size-height"
            @change="setOutputSize('height', ($event.target as HTMLInputElement).value)"
          />
        </div>
        <!-- Nothing is stored until both halves read, so the half-entered state is stated where
             it is being typed. Silence there would be a field that looks filled in and a step
             that does not carry the requirement. -->
        <p
          v-if="outputSizeIncomplete"
          class="text-[10px] text-amber-400"
          data-testid="binary-output-size-incomplete"
        >
          {{ t('pipeline.builder.binaryOutputSizeIncomplete') }}
        </p>
      </div>

      <div v-if="offers('seed')" class="flex items-center gap-2">
        <span class="text-[10px] text-slate-500">{{ t('pipeline.builder.binarySeed') }}</span>
        <UInput
          class="w-56"
          type="number"
          size="xs"
          :model-value="generation.seed === undefined ? '' : String(generation.seed)"
          :placeholder="t('pipeline.builder.binarySeedPlaceholder')"
          data-testid="binary-output-seed"
          @change="
            setGeneration({
              seed: ($event.target as HTMLInputElement).value
                ? Number(($event.target as HTMLInputElement).value)
                : undefined,
            })
          "
        />
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <label v-if="offers('transparent-background')" class="flex items-center gap-1.5">
          <UCheckbox
            :model-value="generation.transparentBackground === true"
            data-testid="binary-output-transparent"
            @update:model-value="
              setGeneration({ transparentBackground: $event ? true : undefined })
            "
          />
          <span class="text-[10px] text-slate-500">{{
            t('pipeline.builder.binaryTransparent')
          }}</span>
        </label>
        <label v-if="offers('tileable')" class="flex items-center gap-1.5">
          <UCheckbox
            :model-value="generation.tileable === true"
            data-testid="binary-output-tileable"
            @update:model-value="setGeneration({ tileable: $event ? true : undefined })"
          />
          <span class="text-[10px] text-slate-500">{{ t('pipeline.builder.binaryTileable') }}</span>
        </label>
        <label v-if="offers('upscale')" class="flex items-center gap-1.5">
          <UCheckbox
            :model-value="generation.upscale !== undefined"
            data-testid="binary-output-upscale"
            @update:model-value="setGeneration({ upscale: $event ? 2 : undefined })"
          />
          <span class="text-[10px] text-slate-500">{{ t('pipeline.builder.binaryUpscale') }}</span>
        </label>
      </div>

      <!-- CANDIDATE COMPARISON: generate several and let a person choose, rather than letting the
           agent commit to one producer unobserved. -->
      <label class="flex items-center gap-1.5">
        <UCheckbox
          :model-value="config.comparison !== undefined"
          data-testid="binary-output-comparison"
          @update:model-value="setComparison($event === true)"
        />
        <span class="text-[10px] text-slate-500">{{ t('pipeline.builder.binaryComparison') }}</span>
      </label>
      <div v-if="config.comparison" class="ms-6 flex flex-wrap items-center gap-3">
        <span class="text-[10px] text-slate-500">{{
          t('pipeline.builder.binaryPerGenerator')
        }}</span>
        <USelect
          class="w-20"
          size="xs"
          :model-value="config.comparison.perGenerator ?? 1"
          :items="[1, 2, 3, 4]"
          data-testid="binary-output-per-generator"
          @update:model-value="setPerGenerator(Number($event))"
        />
        <label class="flex items-center gap-1.5">
          <UCheckbox
            :model-value="config.comparison.multiSelect === true"
            data-testid="binary-output-multi-select"
            @update:model-value="setMultiSelect($event === true)"
          />
          <span class="text-[10px] text-slate-500">{{
            t('pipeline.builder.binaryMultiSelect')
          }}</span>
        </label>
      </div>
      <p
        v-if="comparisonUnreachable"
        class="text-[10px] text-amber-400"
        data-testid="binary-output-comparison-unreachable"
      >
        {{ t('pipeline.builder.binaryComparisonUnreachable') }}
      </p>
    </template>

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
      v-if="has('capability_unsupported')"
      class="text-[10px] text-amber-400"
      data-testid="binary-output-capability-unsupported"
    >
      {{
        t('pipeline.builder.binaryCapabilityUnsupported', {
          capabilities: pick.unsupportedCapabilities.map(capabilityLabel).join(', '),
        })
      }}
    </p>
    <!-- A refusal one notch finer than the one above it: the option is supported everywhere and
         the VALUE is on nobody's list. It names what IS accepted, because a refusal that only
         says no leaves the reader guessing at a set the picker is already holding. -->
    <p
      v-for="value in pick.unacceptedValues"
      :key="value.option"
      class="text-[10px] text-amber-400"
      data-testid="binary-output-value-unaccepted"
    >
      {{
        t('pipeline.builder.binaryOptionValueUnaccepted', {
          option: VALUE_OPTION_LABELS[value.option](),
          requested: value.requested,
          accepted: value.accepted.join(', '),
        })
      }}
    </p>
    <!-- A refusal the SAVE makes on the step's own fields, so it is stated here rather than
         waited for: all three controls are offered together, and the remedy is deleting one of
         two values on this form. -->
    <p
      v-if="has('output_size_ambiguous')"
      class="text-[10px] text-amber-400"
      data-testid="binary-output-size-ambiguous"
    >
      {{
        t('pipeline.builder.binaryOutputSizeAmbiguous', {
          options: pick.conflictingSizeOptions.map((o) => SIZE_CONFLICT_LABELS[o]()).join(', '),
        })
      }}
    </p>
    <!-- ADVISORY, grouped with the other two: an integration that declared no capabilities has
         said only that they are unknown, and every integration registered before this axis
         existed is in exactly that state. Styling it as a refusal would flag most working
         selections in the product. -->
    <p
      v-if="has('capability_unverifiable')"
      class="text-[10px] text-slate-500"
      data-testid="binary-output-capability-unverifiable"
    >
      {{
        t('pipeline.builder.binaryCapabilityUnverifiable', {
          capabilities: pick.unverifiableCapabilities.map(capabilityLabel).join(', '),
        })
      }}
    </p>
    <!-- ADVISORY, and the one of the three the reader can act on precisely: another selected
         integration DOES accept the value, so the step starts, and the ones that will not take it
         are named because dropping or re-routing around them is the whole fix. -->
    <p
      v-for="value in pick.partiallyAcceptedValues"
      :key="value.option"
      class="text-[10px] text-slate-500"
      data-testid="binary-output-value-partial"
    >
      {{
        t('pipeline.builder.binaryOptionValuePartial', {
          option: VALUE_OPTION_LABELS[value.option](),
          requested: value.requested,
          generators: value.refusedBy.join(', '),
        })
      }}
    </p>
    <!-- ADVISORY, grouped with the lines above it: one selected integration refuses the value and
         another has not said what it takes, so the step starts and is served by the second. -->
    <p
      v-if="has('option_value_unverifiable')"
      class="text-[10px] text-slate-500"
      data-testid="binary-output-value-unverifiable"
    >
      {{
        t('pipeline.builder.binaryOptionValueUnverifiable', {
          options: pick.unverifiableValues.map((o) => VALUE_OPTION_LABELS[o]()).join(', '),
        })
      }}
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
