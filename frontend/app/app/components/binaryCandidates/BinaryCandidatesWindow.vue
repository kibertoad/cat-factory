<script setup lang="ts">
// Generated-candidate comparison window: the dedicated surface for a binary-output step that
// generated several candidates rather than committing to one producer unobserved
// (docs/initiatives/binary-output-foundational-storage.md).
//
// It reads the live state straight off the run's step (`step.binaryCandidates`, kept fresh by the
// execution stream) and lets a human KEEP one candidate, or several under distinct ids. Keeping
// re-runs the same step to deliver exactly what survived and clear the rest.
//
// Two properties the surface has to hold on to, both of which are the reason this feature exists:
//
//  - A candidate WITHOUT a preview is still a candidate. An org's asset store may issue no public
//    link, and the platform will not invent one, so such a row renders its details and says the
//    preview is unavailable rather than disappearing or showing a broken image.
//  - It doubles as the RECORD. Once the choice is made the window keeps rendering, marking what
//    was kept and under which id, because the decision is the only place the run's own rationale
//    lives. An AUTOMATIC keep says so: nobody looked at it.
import { computed, ref, watch } from 'vue'
import { useResultView } from '~/composables/useResultView'
import { useExecutionStore } from '~/stores/execution'
import { useBoardStore } from '~/stores/board'
import { useBinaryCandidatesStore } from '~/stores/binaryCandidates'
import {
  BINARY_CANDIDATE_NO_CHOICE_KEYS,
  binaryCandidateHasWarnings,
  binaryCandidateView,
} from '~/utils/binaryCandidates'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'

const execution = useExecutionStore()
const board = useBoardStore()
const candidates = useBinaryCandidatesStore()
const access = useWorkspaceAccess()
const { t } = useI18n()

const { open, blockId, instanceId, stepIndex, close } = useResultView('binary-candidates', {
  onOpen: ({ blockId }) => void candidates.load(blockId),
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const headerTitle = computed(() =>
  block.value
    ? t('binaryCandidates.titleWithBlock', { title: block.value.title })
    : t('binaryCandidates.title'),
)
const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const view = computed(() => binaryCandidateView(step.value))
const warnings = computed(() => (view.value ? binaryCandidateHasWarnings(view.value) : false))
const noChoiceKey = computed(() => {
  const reason = view.value?.state.noChoiceReason
  return reason ? BINARY_CANDIDATE_NO_CHOICE_KEYS[reason] : null
})

/** The ids the human has ticked, and the id each is to be stored under. */
const selected = ref<string[]>([])
const aliases = ref<Record<string, string>>({})
const note = ref('')

// Default the selection to the first candidate of the first subject whenever the candidate set
// changes. Something ticked is the honest default for a single-select comparison (the person is
// choosing between options, not deciding whether to have one) and it keeps the primary button
// meaningful from the first render.
watch(
  () => view.value?.state.candidates.map((c) => c.id).join(','),
  () => {
    const first = view.value?.groups[0]?.rows[0]?.id
    if (selected.value.some((id) => view.value?.state.candidates.some((c) => c.id === id))) return
    selected.value = first ? [first] : []
  },
  { immediate: true },
)

function toggle(id: string): void {
  if (!view.value?.awaiting) return
  if (view.value.multiSelect) {
    selected.value = selected.value.includes(id)
      ? selected.value.filter((existing) => existing !== id)
      : [...selected.value, id]
    return
  }
  selected.value = [id]
}

/**
 * Whether the request would be accepted. Mirrors the backend's own refusals rather than only
 * disabling on emptiness: keeping several candidates under one name would store one artifact and
 * report several, so the alias requirement is stated here, where it can be fixed, instead of
 * arriving as a 422.
 */
const missingAliases = computed(() =>
  selected.value.length > 1 ? selected.value.filter((id) => !(aliases.value[id] ?? '').trim()) : [],
)
const duplicateAliases = computed(() => {
  const used = selected.value.map((id) => (aliases.value[id] ?? '').trim()).filter(Boolean)
  return new Set(used).size !== used.length
})
const canKeep = computed(
  () =>
    view.value?.awaiting === true &&
    !candidates.keeping &&
    selected.value.length > 0 &&
    missingAliases.value.length === 0 &&
    !duplicateAliases.value,
)

async function onKeep() {
  const id = instanceId.value
  if (!id || !canKeep.value) return
  const keep = selected.value.map((candidateId) => {
    const alias = (aliases.value[candidateId] ?? '').trim()
    return alias ? { candidateId, storeAs: alias } : { candidateId }
  })
  const text = note.value.trim()
  await candidates.keep(id, { keep, ...(text ? { note: text } : {}) }).catch(() => {})
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-images"
    icon-class="bg-sky-500/15 text-sky-300"
    :title="headerTitle"
    :subtitle="t('binaryCandidates.subtitle')"
    width="5xl"
    testid="binary-candidates-window"
    @close="close"
  >
    <div v-if="view" class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <!-- Why there was nothing to choose between. Its own line per reason: a model that never
           declared its candidates and one whose block was unreadable need different fixes. -->
      <p
        v-if="noChoiceKey"
        class="mb-3 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200"
        data-testid="binary-candidates-no-choice"
      >
        {{ t(noChoiceKey) }}
      </p>

      <!-- An automatic keep is NOT a review, and must never render as one. -->
      <p
        v-if="view.automatic"
        class="mb-3 rounded border border-slate-600/40 bg-slate-800/40 px-3 py-2 text-xs text-slate-300"
        data-testid="binary-candidates-automatic"
      >
        {{ t('binaryCandidates.automatic') }}
      </p>

      <!-- Every loss the parse counted, so a comparison over three of five cannot read as one
           over all five. -->
      <p
        v-if="warnings"
        class="mb-3 text-xs text-amber-300"
        data-testid="binary-candidates-warnings"
      >
        <span v-if="view.state.omitted">{{
          t('binaryCandidates.warning.omitted', { count: view.state.omitted })
        }}</span>
        <span v-if="view.state.invalidEntries">
          {{ t('binaryCandidates.warning.invalid', { count: view.state.invalidEntries }) }}</span
        >
        <span v-if="view.state.unusablePreviews">
          {{ t('binaryCandidates.warning.previews', { count: view.state.unusablePreviews }) }}</span
        >
      </p>

      <div v-for="group in view.groups" :key="group.subject ?? '·'" class="mb-6">
        <h3 class="mb-2 text-xs font-medium text-slate-400">
          {{ group.subject ?? t('binaryCandidates.unlabelledSubject') }}
        </h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="row in group.rows"
            :key="row.id"
            class="rounded border p-2 transition"
            :class="
              selected.includes(row.id) || row.kept
                ? 'border-sky-400/60 bg-sky-500/5'
                : 'border-slate-700/60'
            "
            data-testid="binary-candidate-card"
            @click="toggle(row.id)"
          >
            <img
              v-if="row.previewUrl"
              :src="row.previewUrl"
              :alt="row.label ?? row.id"
              class="mb-2 max-h-56 w-full rounded object-contain"
              data-testid="binary-candidate-preview"
            />
            <!-- No preview is ORDINARY (a private asset store issues no link), so it is stated
                 rather than left as an empty frame the reader reads as a failed generation. -->
            <p
              v-else
              class="mb-2 flex h-24 items-center justify-center rounded bg-slate-800/60 px-2 text-center text-[10px] text-slate-400"
              data-testid="binary-candidate-no-preview"
            >
              {{ t('binaryCandidates.noPreview') }}
            </p>
            <p class="text-xs text-slate-200">
              {{
                row.generator
                  ? t('binaryCandidates.fromGenerator', { generator: row.generator })
                  : t('binaryCandidates.unattributed')
              }}
            </p>
            <p v-if="row.note" class="mt-1 text-[11px] text-slate-400">{{ row.note }}</p>
            <p class="mt-1 break-all text-[10px] text-slate-500">{{ row.location }}</p>
            <p v-if="row.contentType" class="text-[10px] text-slate-500">{{ row.contentType }}</p>
            <p v-if="row.kept" class="mt-1 text-[11px] text-emerald-300">
              {{
                row.storeAs
                  ? t('binaryCandidates.keptAs', { id: row.storeAs })
                  : t('binaryCandidates.kept')
              }}
            </p>
            <!-- The ALTERNATE ID, shown only where it is load-bearing: keeping two candidates
                 under one name stores one artifact and reports two. -->
            <UInput
              v-if="view.awaiting && view.multiSelect && selected.includes(row.id)"
              class="mt-2"
              size="xs"
              :model-value="aliases[row.id] ?? ''"
              :placeholder="t('binaryCandidates.storeAsPlaceholder')"
              data-testid="binary-candidate-store-as"
              @click.stop
              @update:model-value="aliases[row.id] = String($event)"
            />
          </div>
        </div>
      </div>

      <div v-if="view.awaiting" class="mt-2">
        <UTextarea
          v-model="note"
          :rows="2"
          size="xs"
          :placeholder="t('binaryCandidates.notePlaceholder')"
          data-testid="binary-candidates-note"
        />
        <p
          v-if="missingAliases.length"
          class="mt-1 text-[11px] text-amber-300"
          data-testid="binary-candidates-missing-alias"
        >
          {{ t('binaryCandidates.missingAlias') }}
        </p>
        <p
          v-else-if="duplicateAliases"
          class="mt-1 text-[11px] text-amber-300"
          data-testid="binary-candidates-duplicate-alias"
        >
          {{ t('binaryCandidates.duplicateAlias') }}
        </p>
        <p v-if="candidates.error" class="mt-1 text-[11px] text-red-300">{{ candidates.error }}</p>
        <div class="mt-2 flex justify-end">
          <UButton
            size="xs"
            :disabled="!canKeep || !access.canExecuteRuns.value"
            :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
            :loading="candidates.keeping"
            data-testid="binary-candidates-keep"
            @click="onKeep"
          >
            {{ t('binaryCandidates.keepAction', { count: selected.length }) }}
          </UButton>
        </div>
      </div>
    </div>
  </ResultWindowShell>
</template>
