<script setup lang="ts">
// Visual-confirmation gate window — the dedicated surface for a `visual-confirmation` step
// (opened via the universal result-view host, the same seam the human-test / tester windows
// use). It reads the gate's live state off the execution step (`step.visualConfirm`, pushed
// over the stream), renders each captured screenshot next to its reference design (paired by
// view), and drives the human actions: approve (advance), request a fix from findings (the
// Tester's fixer), or recapture (refresh the pairs). It also lets the human upload reference
// design images for the task.
import { onUnmounted, reactive, ref, watch } from 'vue'
import type { VisualConfirmStepState } from '~/types/execution'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const visualConfirm = useVisualConfirmStore()

// Release the cached screenshot/reference object URLs when the window goes away, so the
// (potentially large) blob bytes don't linger in memory for the rest of the session.
onUnmounted(() => visualConfirm.revokeBlobs())

const { open, blockId, instanceId, stepIndex, close } = useResultView('visual-confirm')
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))

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

const PHASE_LABEL: Record<NonNullable<VisualConfirmStepState['phase']>, string> = {
  awaiting_human: 'Awaiting your review',
  fixing: 'Fixer is addressing your findings…',
  approved: 'Approved',
}

// Resolve each pair's artifact ids to object URLs for the <img>s (cached in the store).
const urls = reactive<Record<string, string>>({})
async function resolveUrl(id: string | null | undefined) {
  if (!id || urls[id]) return
  const url = await visualConfirm.blobUrl(id)
  if (url) urls[id] = url
}
watch(
  pairs,
  (next) => {
    for (const p of next) {
      void resolveUrl(p.actualArtifactId)
      void resolveUrl(p.referenceArtifactId)
    }
  },
  { immediate: true },
)

const findings = ref('')
const showFindings = ref(false)

// When the gate flags its screenshots as an unreliable basis (`degradedReason` — no capture
// happened, a fix failed, or a fix landed AFTER these shots were taken), approving is no longer
// a safe one-click: require the human to explicitly acknowledge they reviewed the change another
// way (or recaptured) first. Re-armed whenever the reason changes so a fresh warning re-gates.
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
  if (!blockId.value || !findings.value.trim()) return
  await visualConfirm.requestFix(blockId.value, findings.value.trim())
  findings.value = ''
  showFindings.value = false
}
async function recapture() {
  if (!blockId.value) return
  await visualConfirm.recapture(blockId.value)
}

// Reference upload.
const uploadView = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !blockId.value) return
  await visualConfirm.uploadReference(blockId.value, file, uploadView.value.trim())
  uploadView.value = ''
  if (fileInput.value) fileInput.value.value = ''
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-stretch justify-center bg-slate-950/70 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="m-4 flex w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
      >
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300"
          >
            <UIcon name="i-lucide-image-play" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              Visual confirmation{{ block ? ` — ${block.title}` : '' }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">
              {{ phase ? PHASE_LABEL[phase] : 'Review the UI against the reference designs' }}
            </p>
          </div>
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <div
            v-if="!vc"
            class="flex flex-col items-center justify-center gap-2 py-10 text-center text-slate-400"
          >
            <UIcon name="i-lucide-image-play" class="h-8 w-8 opacity-40" />
            <p class="text-sm">This step hasn't started yet.</p>
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

            <!-- Actual-vs-reference gallery -->
            <section v-if="pairs.length" class="space-y-4">
              <div
                v-for="(p, i) in pairs"
                :key="i"
                class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
              >
                <h3 class="mb-2 text-[12px] font-semibold text-slate-200">{{ p.view }}</h3>
                <div class="grid grid-cols-2 gap-3">
                  <figure class="space-y-1">
                    <figcaption class="text-[10px] uppercase tracking-wide text-slate-500">
                      Actual
                    </figcaption>
                    <img
                      v-if="p.actualArtifactId && urls[p.actualArtifactId]"
                      :src="urls[p.actualArtifactId]"
                      :alt="`${p.view} (actual)`"
                      class="w-full rounded border border-slate-800"
                    />
                    <div
                      v-else
                      class="flex h-32 items-center justify-center rounded border border-dashed border-slate-700 text-[11px] text-slate-600"
                    >
                      {{ p.actualArtifactId ? 'Loading…' : 'Not captured' }}
                    </div>
                  </figure>
                  <figure class="space-y-1">
                    <figcaption class="text-[10px] uppercase tracking-wide text-slate-500">
                      Reference
                    </figcaption>
                    <img
                      v-if="p.referenceArtifactId && urls[p.referenceArtifactId]"
                      :src="urls[p.referenceArtifactId]"
                      :alt="`${p.view} (reference)`"
                      class="w-full rounded border border-slate-800"
                    />
                    <div
                      v-else
                      class="flex h-32 items-center justify-center rounded border border-dashed border-slate-700 text-[11px] text-slate-600"
                    >
                      {{ p.referenceArtifactId ? 'Loading…' : 'No reference' }}
                    </div>
                  </figure>
                </div>
              </div>
            </section>
            <p v-else class="text-[12px] italic text-slate-500">
              No screenshots were captured — review the change manually.
            </p>

            <!-- Reference upload -->
            <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Upload a reference design
              </h3>
              <div class="flex flex-wrap items-center gap-2">
                <input
                  v-model="uploadView"
                  placeholder="View name (e.g. login)"
                  class="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[12px] text-slate-200 placeholder:text-slate-600"
                />
                <input
                  ref="fileInput"
                  type="file"
                  accept="image/png,image/jpeg"
                  :disabled="busy"
                  class="text-[12px] text-slate-300 file:mr-2 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-slate-200"
                  @change="onFilePicked"
                />
              </div>
            </section>

            <!-- Request fix -->
            <section
              v-if="awaitingHuman"
              class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
            >
              <div class="flex items-center justify-between">
                <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Needs changes?
                </h3>
                <button
                  class="text-[12px] text-slate-400 hover:text-slate-200"
                  @click="showFindings = !showFindings"
                >
                  {{ showFindings ? 'Cancel' : 'Request a fix' }}
                </button>
              </div>
              <div v-if="showFindings" class="mt-2 space-y-2">
                <textarea
                  v-model="findings"
                  rows="4"
                  placeholder="Describe what looks wrong — the Fixer agent gets this as context."
                  class="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
                />
                <UButton
                  size="sm"
                  color="warning"
                  icon="i-lucide-wrench"
                  :loading="busy"
                  :disabled="busy || !findings.trim()"
                  @click="submitFix"
                >
                  Send to Fixer
                </UButton>
              </div>
            </section>

            <!-- Rounds history -->
            <section
              v-if="vc.rounds && vc.rounds.length"
              class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
            >
              <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                History ({{ vc.attempts }} round{{ vc.attempts === 1 ? '' : 's' }})
              </h3>
              <ol class="space-y-2">
                <li v-for="(r, i) in vc.rounds" :key="i" class="flex items-start gap-2 text-[12px]">
                  <UIcon
                    name="i-lucide-wrench"
                    class="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400"
                  />
                  <div class="min-w-0 flex-1">
                    <span class="text-slate-200">Fix requested</span>
                    <span
                      class="ml-1.5 rounded px-1 text-[10px] uppercase"
                      :class="
                        r.outcome === 'completed'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : r.outcome === 'failed'
                            ? 'bg-rose-500/15 text-rose-300'
                            : 'bg-slate-500/15 text-slate-300'
                      "
                    >
                      {{ r.outcome ?? 'in progress' }}
                    </span>
                    <p v-if="r.findings" class="leading-snug text-slate-400">{{ r.findings }}</p>
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
              I've reviewed this manually
            </label>
            <UButton
              size="sm"
              variant="soft"
              color="neutral"
              icon="i-lucide-refresh-cw"
              :loading="busy"
              :disabled="busy || !awaitingHuman"
              @click="recapture"
            >
              Recapture
            </UButton>
            <UButton
              color="primary"
              icon="i-lucide-circle-check"
              :loading="busy"
              :disabled="!canApprove"
              @click="approve"
            >
              Approve — continue
            </UButton>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
