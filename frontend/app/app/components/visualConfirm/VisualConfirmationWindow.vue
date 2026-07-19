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
import type { VisualConfirmStepState } from '~/types/execution'
import { useArtifactBlobs } from '~/composables/useArtifactBlobs'
import ImageCompare from '~/components/media/ImageCompare.vue'
import ArtifactLightbox from '~/components/media/ArtifactLightbox.vue'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const visualConfirm = useVisualConfirmStore()
const { t } = useI18n()
const access = useWorkspaceAccess()

// Per-window blob cache; release the cached screenshot/reference object URLs when the window
// goes away, so the (potentially large) blob bytes don't linger for the rest of the session.
const blobs = useArtifactBlobs()
onUnmounted(() => blobs.revokeAll())

// `manageEscape: false` — `ResultWindowShell` owns Escape (and the focus trap + scroll lock +
// stacking); the nested lightbox layers above it on the same shared overlay stack.
const { open, blockId, instanceId, stepIndex, close } = useResultView('visual-confirm', {
  manageEscape: false,
})
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
const fileInput = ref<HTMLInputElement | null>(null)
async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  const view = uploadView.value.trim()
  // Require a view name: a reference with no view can't pair with any captured screenshot,
  // so it would be silently orphaned. The input is also disabled until a view is entered.
  if (!file || !blockId.value || !view) {
    if (fileInput.value) fileInput.value.value = ''
    return
  }
  await visualConfirm.uploadReference(blockId.value, file, view)
  uploadView.value = ''
  if (fileInput.value) fileInput.value.value = ''
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
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-image-play"
    icon-class="bg-amber-500/15 text-amber-300"
    :title="headerTitle"
    :subtitle="phase ? PHASE_LABEL[phase] : t('visualConfirm.subtitle')"
    width="5xl"
    @close="close"
  >
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <div
        v-if="!vc"
        class="flex flex-col items-center justify-center gap-2 py-10 text-center text-slate-400"
      >
        <UIcon name="i-lucide-image-play" class="h-8 w-8 opacity-40" />
        <p class="text-sm">{{ t('visualConfirm.notStarted') }}</p>
      </div>

      <template v-else>
        <p
          v-if="vc.degradedReason"
          class="rounded-lg border border-amber-700/40 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-300/90"
        >
          {{ vc.degradedReason }}
        </p>

        <p
          v-if="working"
          class="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-[12px] text-slate-300"
        >
          <UIcon name="i-lucide-loader" class="h-3.5 w-3.5 animate-spin text-amber-300" />
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
              :blobs="blobs"
              :busy="busy"
              @expand="expand"
              @upload-reference="(file: File) => uploadFor(p.view, file)"
            />
            <!-- Per-view note (folded into the fixer findings) -->
            <div v-if="awaitingHuman" class="px-1">
              <button
                class="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200"
                @click="noteOpen[p.view] = !noteOpen[p.view]"
              >
                <UIcon
                  :name="noteOpen[p.view] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  class="h-3 w-3"
                />
                {{ t('visualConfirm.noteIssue', { view: p.view }) }}
                <span
                  v-if="perViewNotes[p.view]?.trim()"
                  class="rounded-full bg-amber-500/15 px-1.5 text-[9px] text-amber-300"
                  >{{ t('visualConfirm.noted') }}</span
                >
              </button>
              <textarea
                v-if="noteOpen[p.view]"
                v-model="perViewNotes[p.view]"
                rows="2"
                :placeholder="t('visualConfirm.notePlaceholder', { view: p.view })"
                class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-[12px] text-slate-200 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
              />
            </div>
          </div>
        </section>
        <p v-else class="text-[12px] italic text-slate-500">
          {{ t('visualConfirm.noScreenshots') }}
        </p>

        <!-- Upload a reference for any view -->
        <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
          <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {{ t('visualConfirm.upload.heading') }}
          </h3>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="uploadView"
              list="vc-views"
              :placeholder="t('visualConfirm.upload.viewPlaceholder')"
              class="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[12px] text-slate-200 placeholder:text-slate-600"
            />
            <datalist id="vc-views">
              <option v-for="p in pairs" :key="p.view" :value="p.view" />
            </datalist>
            <input
              ref="fileInput"
              type="file"
              accept="image/png,image/jpeg"
              :disabled="busy || !uploadView.trim()"
              class="text-[12px] text-slate-300 file:me-2 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-slate-200 disabled:opacity-40"
              @change="onFilePicked"
            />
          </div>
          <p class="mt-1.5 text-[10px] text-slate-600">
            {{
              uploadView.trim()
                ? t('visualConfirm.upload.tipReady')
                : t('visualConfirm.upload.tipNeedView')
            }}
          </p>
        </section>

        <!-- Request fix -->
        <section
          v-if="awaitingHuman"
          class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
        >
          <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {{ t('visualConfirm.requestFix.heading') }}
          </h3>
          <textarea
            v-model="globalFindings"
            rows="3"
            :placeholder="t('visualConfirm.requestFix.placeholder')"
            class="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
          />
          <div class="mt-2 flex items-center justify-between">
            <span class="text-[11px] text-slate-500">
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
          class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
        >
          <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {{ t('visualConfirm.history.heading', { count: vc.attempts }, vc.attempts) }}
          </h3>
          <ol class="space-y-2">
            <li v-for="(r, i) in vc.rounds" :key="i" class="flex items-start gap-2 text-[12px]">
              <UIcon name="i-lucide-wrench" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
              <div class="min-w-0 flex-1">
                <span class="text-slate-200">{{ t('visualConfirm.history.fixRequested') }}</span>
                <span
                  class="ms-1.5 rounded px-1 text-[10px] uppercase"
                  :class="
                    r.outcome === 'completed'
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : r.outcome === 'failed'
                        ? 'bg-rose-500/15 text-rose-300'
                        : 'bg-slate-500/15 text-slate-300'
                  "
                >
                  {{
                    r.outcome ? OUTCOME_LABELS[r.outcome] : t('visualConfirm.outcome.inProgress')
                  }}
                </span>
                <p v-if="r.findings" class="whitespace-pre-wrap leading-snug text-slate-400">
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
      class="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3"
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
        <label
          v-if="awaitingHuman && needsAck"
          class="flex items-center gap-1.5 text-[11px] text-amber-300/90"
        >
          <input v-model="ackDegraded" type="checkbox" class="accent-amber-500" />
          {{ t('visualConfirm.reviewedManually') }}
        </label>
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
