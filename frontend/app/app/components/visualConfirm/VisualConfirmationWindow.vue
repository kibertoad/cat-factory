<script setup lang="ts">
// Visual-confirmation gate window — the dedicated surface for a `visual-confirmation` step
// (opened via the universal result-view host, the same seam the human-test / tester windows
// use). It reads the gate's live state off the execution step (`step.visualConfirm`, pushed
// over the stream), renders each captured screenshot against its reference design (via the
// reusable <ImageCompare>: side-by-side / overlay / swipe / diff, with click-to-zoom into the
// shared <ArtifactLightbox>), and drives the human actions: approve (advance), request a fix
// (per-view notes + a freeform box, composed into the Tester's fixer findings), or recapture.
// References can be dropped straight onto a pair, or uploaded for any view below.
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import type { VisualConfirmDesignGapReason, VisualConfirmStepState } from '~/types/execution'
import { useArtifactBlobs } from '~/composables/useArtifactBlobs'
import ImageCompare from '~/components/media/ImageCompare.vue'
import ArtifactLightbox from '~/components/media/ArtifactLightbox.vue'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'
import SectionLabel from '~/components/common/SectionLabel.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const visualConfirm = useVisualConfirmStore()
const { t } = useI18n()
const access = useWorkspaceAccess()

// Per-window blob cache; release the cached screenshot/reference object URLs when the window
// goes away, so the (potentially large) blob bytes don't linger for the rest of the session.
const blobs = useArtifactBlobs()
onUnmounted(() => blobs.revokeAll())

// `ResultWindowShell` owns Escape (and the focus trap + scroll lock + stacking); the nested
// lightbox layers above it on the same shared overlay stack.
const { open, blockId, instanceId, stepIndex, close } = useResultView('visual-confirm')
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const headerTitle = computed(() =>
  block.value
    ? t('visualConfirm.titleWithBlock', { title: block.value.title })
    : t('visualConfirm.title'),
)

const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const vc = computed<VisualConfirmStepState | null>(() => step.value?.visualConfirm ?? null)
const phase = computed(() => vc.value?.phase ?? null)
const pairs = computed(() => vc.value?.pairs ?? [])
const busy = computed(() => (blockId.value ? visualConfirm.isBusy(blockId.value) : false))
const awaitingHuman = computed(() => phase.value === 'awaiting_human')
const working = computed(() => phase.value === 'fixing')

const PHASE_LABEL = computed<Record<NonNullable<VisualConfirmStepState['phase']>, string>>(() => ({
  awaiting_human: t('visualConfirm.phase.awaiting_human'),
  fixing: t('visualConfirm.phase.fixing'),
  approved: t('visualConfirm.phase.approved'),
}))

// Exhaustive map of a round's outcome enum → label (literal keys keep the typed-key drift
// guard live, vs a runtime-built `visualConfirm.outcome.${outcome}`).
const OUTCOME_LABELS = computed<Record<'completed' | 'failed', string>>(() => ({
  completed: t('visualConfirm.outcome.completed'),
  failed: t('visualConfirm.outcome.failed'),
}))

// What the task's LINKED DESIGNS contributed. Present whenever a design is linked, including
// when everything worked: a reviewer comparing a screen against a Figma frame needs to know the
// frame is the design's own, and one seeing no design frames needs to know whether a design is
// linked at all. Absent ⇒ the task links none, which this panel must not invent a line about.
const design = computed(() => vc.value?.designReferences ?? null)

// Exhaustive map of the gap vocabulary → copy, literal-keyed for the same drift-guard reason as
// the outcome labels above. Each names a DIFFERENT fix, which is why the backend keeps them apart
// instead of collapsing them into one "no images" absence.
const DESIGN_GAP_LABELS = computed<Record<VisualConfirmDesignGapReason, string>>(() => ({
  partial: t('visualConfirm.design.gap.partial'),
  failed: t('visualConfirm.design.gap.failed'),
  none: t('visualConfirm.design.gap.none'),
  storage_unavailable: t('visualConfirm.design.gap.storage_unavailable'),
  not_retained: t('visualConfirm.design.gap.not_retained'),
}))

// Resolve every pair's artifacts (the gallery + the lightbox share this one cache).
watch(
  pairs,
  (next) => {
    for (const p of next) {
      void blobs.resolve(p.actualArtifactId)
      void blobs.resolve(p.referenceArtifactId)
    }
  },
  { immediate: true },
)

// Flat list of all images (actual then reference, per pair) for the lightbox + its index.
const lightboxItems = computed(() => {
  const items: { artifactId: string; label: string; alt: string }[] = []
  for (const p of pairs.value) {
    if (p.actualArtifactId)
      items.push({
        artifactId: p.actualArtifactId,
        label: t('visualConfirm.lightbox.actualLabel', { view: p.view }),
        alt: t('visualConfirm.lightbox.actualAlt', { view: p.view }),
      })
    if (p.referenceArtifactId)
      items.push({
        artifactId: p.referenceArtifactId,
        label: t('visualConfirm.lightbox.referenceLabel', { view: p.view }),
        alt: t('visualConfirm.lightbox.referenceAlt', { view: p.view }),
      })
  }
  return items
})
const lightboxOpen = ref(false)
const lightboxIndex = ref(0)
function expand(artifactId: string) {
  const i = lightboxItems.value.findIndex((it) => it.artifactId === artifactId)
  lightboxIndex.value = i < 0 ? 0 : i
  lightboxOpen.value = true
}

// --- Request a fix: per-view notes + a freeform box, composed into one findings string. ---
const perViewNotes = reactive<Record<string, string>>({})
const noteOpen = reactive<Record<string, boolean>>({})
const globalFindings = ref('')

const hasFindings = computed(
  () => globalFindings.value.trim() !== '' || pairs.value.some((p) => perViewNotes[p.view]?.trim()),
)

/**
 * Confirm before discarding the drafted findings (UX-79). Both halves count: the per-view notes are
 * anchored to a specific screenshot and cannot be reconstructed from memory, and the freeform box is
 * the overall verdict. They are composed into one findings string only when Request fix is pressed,
 * which resolves the gate and dispatches a fixer, so a stray Escape may not send them.
 *
 * The snapshot is exactly what Request fix WOULD send, read off `buildFindings` rather than off the
 * note map. A recapture returns a different pair set and never prunes `perViewNotes`, so a note left
 * behind against a view that is gone is unsendable, and reporting it here would prompt to discard
 * something the button could not have submitted anyway.
 */
const { requestClose } = useUnsavedGuard({
  open,
  close: () => close(),
  saving: () => busy.value,
  snapshot: () => buildFindings().structured,
})

/** Compose the per-view notes + freeform text into the fixer's findings (and a structured
 * mirror, so a future structured-findings contract is a one-line swap). */
function buildFindings(): { text: string; structured: { view?: string; note: string }[] } {
  const structured: { view?: string; note: string }[] = []
  const blocks: string[] = []
  for (const p of pairs.value) {
    const note = perViewNotes[p.view]?.trim()
    if (note) {
      structured.push({ view: p.view, note })
      blocks.push(`### ${p.view}\n${note}`)
    }
  }
  const general = globalFindings.value.trim()
  if (general) {
    structured.push({ note: general })
    blocks.push(`### General\n${general}`)
  }
  return { text: blocks.join('\n\n'), structured }
}

// Degraded-basis approval guard (no capture / a fix landed after these shots): require an
// explicit "I reviewed this another way" acknowledgement before the one-click approve.
const ackDegraded = ref(false)
watch(
  () => vc.value?.degradedReason ?? null,
  () => {
    ackDegraded.value = false
  },
)
const needsAck = computed(() => !!vc.value?.degradedReason)
const canApprove = computed(
  () => awaitingHuman.value && !busy.value && (!needsAck.value || ackDegraded.value),
)

async function approve() {
  if (!blockId.value || !canApprove.value) return
  await visualConfirm.approve(blockId.value)
  close()
}
async function submitFix() {
  if (!blockId.value || !hasFindings.value) return
  await visualConfirm.requestFix(blockId.value, buildFindings().text)
  globalFindings.value = ''
  for (const k of Object.keys(perViewNotes)) delete perViewNotes[k]
  for (const k of Object.keys(noteOpen)) delete noteOpen[k]
}
async function recapture() {
  if (!blockId.value) return
  await visualConfirm.recapture(blockId.value)
}

// --- Reference upload (per-pair drop, plus a free "any view" picker below). ---
async function uploadFor(view: string, file: File) {
  if (!blockId.value) return
  await visualConfirm.uploadReference(blockId.value, file, view)
}
const uploadView = ref('')
// The views this run already captured, offered as suggestions on the combobox.
const viewSuggestions = computed(() => pairs.value.map((p) => p.view))
const pendingUpload = ref<File | null>(null)
watch(pendingUpload, async (file) => {
  const view = uploadView.value.trim()
  // Require a view name: a reference with no view can't pair with any captured screenshot,
  // so it would be silently orphaned. The control is also disabled until a view is entered.
  if (!file || !blockId.value || !view) {
    pendingUpload.value = null
    return
  }
  await visualConfirm.uploadReference(blockId.value, file, view)
  uploadView.value = ''
  // Cleared so a fresh pick is a fresh file. `UFileUpload` carries `reset` for the other half of
  // this: without it the native input keeps its value and the SAME file fires no change event.
  pendingUpload.value = null
})
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-image-play"
    icon-class="bg-app-warning-500/15 text-app-warning-300"
    :title="headerTitle"
    :subtitle="phase ? PHASE_LABEL[phase] : t('visualConfirm.subtitle')"
    width="5xl"
    @close="requestClose"
  >
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <div
        v-if="!vc"
        class="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted"
      >
        <UIcon name="i-lucide-image-play" class="h-8 w-8 opacity-40" />
        <p class="text-sm">{{ t('visualConfirm.notStarted') }}</p>
      </div>

      <template v-else>
        <p
          v-if="vc.degradedReason"
          class="rounded-lg border border-app-warning-700/40 bg-app-warning-500/5 px-3 py-2 text-xs text-app-warning-300/90"
        >
          {{ vc.degradedReason }}
        </p>

        <!-- What the linked designs contributed. Rendered even when nothing is missing, so a
             reference the reviewer is judging against is never anonymous. -->
        <section
          v-if="design"
          class="rounded-lg border border-default bg-default/60 px-3 py-2 text-xs text-toned"
        >
          <p class="flex items-center gap-1.5">
            <UIcon name="i-lucide-figma" class="h-3.5 w-3.5 shrink-0 text-app-warning-300" />
            <span>{{
              t('visualConfirm.design.summary', { count: design.images }, design.images)
            }}</span>
            <span v-if="design.dropped" class="text-dimmed">
              {{ t('visualConfirm.design.dropped', { count: design.dropped }, design.dropped) }}
            </span>
          </p>
          <!-- One line per short design, carrying both ways it can fall short: what its source
               kept, and what this gallery's shared ceiling cut from it. A design the ceiling shut
               out entirely reads as one with no frames unless it is named here. -->
          <ul v-if="design.gaps?.length" class="mt-1.5 space-y-1 text-2xs text-app-warning-300/90">
            <li v-for="gap in design.gaps" :key="`${gap.title}-${gap.reason ?? 'capped'}`">
              {{ t('visualConfirm.design.gapLine', { title: gap.title }) }}
              <template v-if="gap.reason">{{ DESIGN_GAP_LABELS[gap.reason] }}</template>
              <template v-if="gap.dropped">{{
                t('visualConfirm.design.gapDropped', { count: gap.dropped }, gap.dropped)
              }}</template>
            </li>
          </ul>
        </section>

        <p
          v-if="working"
          class="flex items-center gap-2 rounded-lg border border-default bg-app-950/40 px-3 py-2 text-xs text-toned"
        >
          <UIcon name="i-lucide-loader" class="h-3.5 w-3.5 animate-spin text-app-warning-300" />
          {{ phase ? PHASE_LABEL[phase] : '' }}
        </p>

        <!-- Actual-vs-reference gallery. Keyed by `view` (the contract's unique per-pair
                 identity) so a pair's note/expand state stays bound to its view across recaptures. -->
        <section v-if="pairs.length" class="space-y-4">
          <div v-for="p in pairs" :key="p.view" class="space-y-2">
            <ImageCompare
              :view="p.view"
              :actual-id="p.actualArtifactId"
              :reference-id="p.referenceArtifactId"
              :reference-origin="p.referenceOrigin"
              :blobs="blobs"
              :busy="busy"
              @expand="expand"
              @upload-reference="(file: File) => uploadFor(p.view, file)"
            />
            <!-- Per-view note (folded into the fixer findings) -->
            <div v-if="awaitingHuman" class="px-1">
              <UButton
                color="neutral"
                variant="ghost"
                class="flex items-center gap-1.5 p-0 text-2xs text-muted hover:bg-transparent hover:text-default"
                @click="noteOpen[p.view] = !noteOpen[p.view]"
              >
                <UIcon
                  :name="noteOpen[p.view] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  class="h-3 w-3"
                />
                {{ t('visualConfirm.noteIssue', { view: p.view }) }}
                <span
                  v-if="perViewNotes[p.view]?.trim()"
                  class="rounded-full bg-app-warning-500/15 px-1.5 text-3xs text-app-warning-300"
                  >{{ t('visualConfirm.noted') }}</span
                >
              </UButton>
              <UTextarea
                v-if="noteOpen[p.view]"
                v-model="perViewNotes[p.view]"
                :rows="2"
                :placeholder="t('visualConfirm.notePlaceholder', { view: p.view })"
                size="xs"
                class="mt-1 w-full"
              />
            </div>
          </div>
        </section>
        <p v-else class="text-xs italic text-dimmed">
          {{ t('visualConfirm.noScreenshots') }}
        </p>

        <!-- Upload a reference for any view -->
        <section class="rounded-lg border border-default bg-default/60 p-3">
          <SectionLabel as="h3" class="mb-2">
            {{ t('visualConfirm.upload.heading') }}
          </SectionLabel>
          <div class="flex flex-wrap items-center gap-2">
            <!-- The known views are suggestions, not a closed list: a reference can be uploaded
                 for a view the run has not produced yet, which is the case this field exists for.
                 `mode="autocomplete"` is what makes that work: the DEFAULT combobox mode writes
                 its model only when something is SELECTED, so typing a new view name would leave
                 `uploadView` empty and the picker beside it disabled. -->
            <UInputMenu
              v-model="uploadView"
              mode="autocomplete"
              :items="viewSuggestions"
              size="xs"
              :placeholder="t('visualConfirm.upload.viewPlaceholder')"
            />
            <!-- `reset` so the native input is cleared on every open: re-picking the SAME file
                 after a rejected or completed upload otherwise fires no change event at all. -->
            <UFileUpload
              v-model="pendingUpload"
              variant="button"
              size="xs"
              reset
              accept="image/png,image/jpeg"
              :preview="false"
              :disabled="busy || !uploadView.trim()"
              :label="t('visualConfirm.upload.choose')"
            />
          </div>
          <p class="mt-1.5 text-3xs text-app-600">
            {{
              uploadView.trim()
                ? t('visualConfirm.upload.tipReady')
                : t('visualConfirm.upload.tipNeedView')
            }}
          </p>
        </section>

        <!-- Request fix -->
        <section v-if="awaitingHuman" class="rounded-lg border border-default bg-default/60 p-3">
          <SectionLabel as="h3" class="mb-2">
            {{ t('visualConfirm.requestFix.heading') }}
          </SectionLabel>
          <UTextarea
            v-model="globalFindings"
            :rows="3"
            :placeholder="t('visualConfirm.requestFix.placeholder')"
            size="sm"
            class="w-full"
          />
          <div class="mt-2 flex items-center justify-between">
            <span class="text-2xs text-dimmed">
              {{ t('visualConfirm.requestFix.foldedHint') }}
            </span>
            <UButton
              size="sm"
              color="warning"
              icon="i-lucide-wrench"
              :loading="busy"
              :disabled="busy || !hasFindings || !access.canExecuteRuns.value"
              :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
              @click="submitFix"
            >
              {{ t('visualConfirm.requestFix.send') }}
            </UButton>
          </div>
        </section>

        <!-- Rounds history -->
        <section
          v-if="vc.rounds && vc.rounds.length"
          class="rounded-lg border border-default bg-default/60 p-3"
        >
          <SectionLabel as="h3" class="mb-2">
            {{ t('visualConfirm.history.heading', { count: vc.attempts }, vc.attempts) }}
          </SectionLabel>
          <ol class="space-y-2">
            <li v-for="(r, i) in vc.rounds" :key="i" class="flex items-start gap-2 text-xs">
              <UIcon name="i-lucide-wrench" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
              <div class="min-w-0 flex-1">
                <span class="text-default">{{ t('visualConfirm.history.fixRequested') }}</span>
                <span
                  class="ms-1.5 rounded px-1 text-3xs uppercase"
                  :class="
                    r.outcome === 'completed'
                      ? 'bg-app-success-500/15 text-app-success-300'
                      : r.outcome === 'failed'
                        ? 'bg-app-error-500/15 text-app-error-300'
                        : 'bg-app-500/15 text-toned'
                  "
                >
                  {{
                    r.outcome ? OUTCOME_LABELS[r.outcome] : t('visualConfirm.outcome.inProgress')
                  }}
                </span>
                <p v-if="r.findings" class="whitespace-pre-wrap leading-snug text-muted">
                  {{ r.findings }}
                </p>
              </div>
            </li>
          </ol>
        </section>
      </template>
    </div>

    <footer
      v-if="vc"
      class="flex items-center justify-between gap-3 border-t border-default px-5 py-3"
    >
      <StepRunMeta
        v-if="step"
        :step="step"
        :instance-id="instanceId ?? undefined"
        :step-number="stepIndex === null ? undefined : stepIndex + 1"
        :total-steps="instance?.steps.length"
        :run-failed="instance?.status === 'failed'"
        :failure-at="instance?.failure?.occurredAt"
      />
      <div class="flex items-center gap-2">
        <UCheckbox
          v-if="awaitingHuman && needsAck"
          v-model="ackDegraded"
          size="xs"
          color="warning"
          :label="t('visualConfirm.reviewedManually')"
        />
        <UButton
          size="sm"
          variant="soft"
          color="neutral"
          icon="i-lucide-refresh-cw"
          :loading="busy"
          :disabled="busy || !awaitingHuman || !access.canExecuteRuns.value"
          :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
          @click="recapture"
        >
          {{ t('visualConfirm.recapture') }}
        </UButton>
        <UButton
          color="primary"
          icon="i-lucide-circle-check"
          :loading="busy"
          :disabled="!canApprove || !access.canExecuteRuns.value"
          :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
          @click="approve"
        >
          {{ t('visualConfirm.approve') }}
        </UButton>
      </div>
    </footer>
  </ResultWindowShell>

  <!-- Shared zoom/pan viewer for any screenshot in the gallery — a sibling overlay that layers
       above this window on the shared modal stack while open. -->
  <ArtifactLightbox
    v-model:open="lightboxOpen"
    v-model:index="lightboxIndex"
    :items="lightboxItems"
    :blobs="blobs"
  />
</template>
