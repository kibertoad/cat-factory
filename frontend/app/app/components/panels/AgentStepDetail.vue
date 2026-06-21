<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type { AgentState } from '~/types/domain'
import { agentKindMeta } from '~/utils/catalog'
import { parseOutputOutline, sliceSource } from '~/utils/agentOutput'
import { subtaskIconClass } from '~/utils/pipelineRender'
import StepMetricsBar from '~/components/observability/StepMetricsBar.vue'

// Detail overlay for a single pipeline step. Opened by clicking an agent in the
// inspector list (TaskExecution) or the focus-view pipeline (PipelineProgress) via
// `ui.openStepDetail(instanceId, stepIndex)`. It resolves the step from the
// execution store so it stays live while open, and shows the step's metadata
// (state, timing, model, subtasks, fragments, decision/approval). When the agent
// produced prose (architect, researcher, reviewer, …) it also renders that output
// as markdown, split into collapsible sections with an auto-generated ToC sidebar.
const ui = useUiStore()
const execution = useExecutionStore()
const board = useBoardStore()
const models = useModelsStore()

onMounted(() => models.ensureLoaded())

const ctx = computed(() => ui.stepDetail)
const instance = computed(() => execution.getInstance(ctx.value?.instanceId))
const step = computed(() =>
  ctx.value ? (instance.value?.steps[ctx.value.stepIndex] ?? null) : null,
)
const block = computed(() => (instance.value ? board.getBlock(instance.value.blockId) : undefined))
const agent = computed(() => (step.value ? agentKindMeta(step.value.agentKind) : null))
const open = computed(() => !!ctx.value && !!step.value)

const stepNumber = computed(() => (ctx.value ? ctx.value.stepIndex + 1 : 0))
const totalSteps = computed(() => instance.value?.steps.length ?? 0)

const STATE_META: Record<AgentState, { label: string; color: string }> = {
  pending: { label: 'Pending', color: '#64748b' },
  working: { label: 'Working', color: '#6366f1' },
  waiting_decision: { label: 'Needs input', color: '#f59e0b' },
  done: { label: 'Done', color: '#22c55e' },
}

// A 1s tick so a still-running step's elapsed time counts up live while open.
const nowTick = ref(0)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  nowTick.value = Date.now()
  timer = setInterval(() => (nowTick.value = Date.now()), 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

// A failed run is no longer executing: a step left mid-flight (state still
// `working`, no `finishedAt`) must stop looking live — no ticking clock, no
// "spinning up" phase, no spinner.
const runFailed = computed(() => instance.value?.status === 'failed')
const isRunning = computed(
  () => !!step.value?.startedAt && !step.value?.finishedAt && !runFailed.value,
)
/** Elapsed/total execution time in ms — null until the step has started. */
const durationMs = computed(() => {
  const s = step.value
  if (s?.startedAt == null) return null
  // Freeze the clock at the failure time once the run has failed (a mid-flight
  // step has no `finishedAt`, so the live tick would otherwise count up forever).
  const end =
    s.finishedAt ??
    (runFailed.value ? (instance.value?.failure?.occurredAt ?? s.startedAt) : nowTick.value)
  return Math.max(0, end - s.startedAt)
})

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`
  const h = Math.floor(m / 60)
  const min = m % 60
  return min ? `${h}h ${min}m` : `${h}h`
}
function formatClock(ms?: number | null): string | null {
  return ms ? new Date(ms).toLocaleString() : null
}

const durationLabel = computed(() =>
  durationMs.value == null ? null : formatDuration(durationMs.value),
)
const modelLabel = computed(() => (step.value?.model ? models.labelForRef(step.value.model) : null))

const ITEM_ICON: Record<string, string> = {
  completed: 'i-lucide-check-circle-2',
  in_progress: 'i-lucide-loader-circle',
  pending: 'i-lucide-circle',
}

// --- prose reader (only when the step produced output) -----------------------
const outline = computed(() => parseOutputOutline(step.value?.output ?? ''))
const tocSections = computed(() => outline.value.sections.filter((s) => s.depth > 0))
const hasOutput = computed(() => !!step.value?.output?.trim())

const collapsed = reactive<Record<string, boolean>>({})
const activeId = ref<string>('step-details')
const scrollEl = ref<HTMLElement | null>(null)
const sectionEls = reactive<Record<string, HTMLElement | null>>({})

// Anchors the ToC navigates + the scroll-spy tracks: the details card first, then
// every heading section of the prose.
const anchors = computed(() => ['step-details', ...tocSections.value.map((s) => s.id)])

// Re-seed (all sections expanded, scrolled to top) whenever a different step opens.
watch(
  () => ctx.value && `${ctx.value.instanceId}:${ctx.value.stepIndex}`,
  (key) => {
    for (const k of Object.keys(collapsed)) delete collapsed[k]
    activeId.value = 'step-details'
    // Reset the review draft whenever a different gate/step opens.
    reviewComments.value = []
    feedback.value = ''
    draftTarget.value = null
    draftBody.value = ''
    rejectArmed.value = false
    editing.value = false
    draftProposal.value = ''
    if (key) void nextTick(() => scrollEl.value?.scrollTo({ top: 0 }))
  },
)

function close() {
  // Reset the new approval-mode sub-states so reopening the same step is clean
  // (the step-change watch only fires when the step key actually changes).
  editing.value = false
  draftProposal.value = ''
  rejectArmed.value = false
  ui.closeStepDetail()
}
onKeyStroke('Escape', () => {
  if (open.value) close()
})

function toggle(id: string) {
  collapsed[id] = !collapsed[id]
}
function setAll(value: boolean) {
  for (const s of outline.value.sections) collapsed[s.id] = value
}
const allCollapsed = computed(
  () => outline.value.sections.length > 0 && outline.value.sections.every((s) => collapsed[s.id]),
)

async function goTo(id: string) {
  if (collapsed[id]) collapsed[id] = false
  activeId.value = id
  await nextTick()
  sectionEls[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function onScroll() {
  const container = scrollEl.value
  if (!container) return
  const line = container.getBoundingClientRect().top + 80
  let current = anchors.value[0] ?? 'step-details'
  for (const id of anchors.value) {
    const el = sectionEls[id]
    if (el && el.getBoundingClientRect().top <= line) current = id
    else break
  }
  activeId.value = current
}

async function copyOutput() {
  if (step.value?.output) await navigator.clipboard?.writeText(step.value.output)
}

// --- approval mode (GitHub-style review of a pending gate) -------------------
// When the step's gate is pending the reader doubles as the approval surface: the
// human can comment on individual blocks of the output (the rendered markdown
// carries `data-src-start/end` from agentOutput), leave overall feedback, then
// Approve / Request changes / Reject.
interface DraftComment {
  srcStart: number
  srcEnd: number
  quotedSource: string
  body: string
}
const approvalPending = computed(() => step.value?.approval?.status === 'pending')
const approvalId = computed(() => step.value?.approval?.id ?? null)
const reviewComments = ref<DraftComment[]>([])
const feedback = ref('')
const submitting = ref(false)
const draftTarget = ref<{ srcStart: number; srcEnd: number; quotedSource: string } | null>(null)
const draftBody = ref('')

const blockKey = (c: { srcStart: number; srcEnd: number }) => `${c.srcStart}:${c.srcEnd}`

/** Toggle the highlight classes on commented / selected blocks within the reader. */
function syncHighlights() {
  const root = scrollEl.value
  if (!root) return
  const commented = new Set(reviewComments.value.map(blockKey))
  const selected = draftTarget.value ? blockKey(draftTarget.value) : null
  for (const el of Array.from(root.querySelectorAll('[data-src-start]'))) {
    const key = `${el.getAttribute('data-src-start')}:${el.getAttribute('data-src-end')}`
    el.classList.toggle('cf-commented', commented.has(key))
    el.classList.toggle('cf-selected', key === selected)
  }
}

/** Click a rendered block to start commenting on it (links keep working). */
function onProseClick(e: MouseEvent) {
  if (!approvalPending.value || editing.value) return
  const target = e.target as HTMLElement
  if (target.closest('a')) return
  const blockEl = target.closest('[data-src-start]') as HTMLElement | null
  if (!blockEl) return
  const srcStart = Number(blockEl.getAttribute('data-src-start'))
  const srcEnd = Number(blockEl.getAttribute('data-src-end'))
  if (Number.isNaN(srcStart) || Number.isNaN(srcEnd)) return
  draftTarget.value = {
    srcStart,
    srcEnd,
    quotedSource: sliceSource(step.value?.output ?? '', srcStart, srcEnd),
  }
  draftBody.value = ''
  void nextTick(syncHighlights)
}

function addDraftComment() {
  if (!draftTarget.value || !draftBody.value.trim()) return
  reviewComments.value.push({ ...draftTarget.value, body: draftBody.value.trim() })
  draftTarget.value = null
  draftBody.value = ''
  void nextTick(syncHighlights)
}
function cancelDraft() {
  draftTarget.value = null
  draftBody.value = ''
  void nextTick(syncHighlights)
}
function removeComment(idx: number) {
  reviewComments.value.splice(idx, 1)
  void nextTick(syncHighlights)
}

const canRequestChanges = computed(() => !!feedback.value.trim() || reviewComments.value.length > 0)

// Plain approve: accept the agent's proposal verbatim and advance.
async function approve() {
  if (!ctx.value || !approvalId.value || submitting.value) return
  submitting.value = true
  try {
    await execution.approveStep(ctx.value.instanceId, approvalId.value)
    close()
  } finally {
    submitting.value = false
  }
}

// --- "Approve with corrections" (edit-then-approve) --------------------------
// A deliberate mode distinct from the read-only review: the human edits the
// conclusions directly and those edits flow forward as the approved proposal. It
// CANNOT be mixed with the request-changes/comments path — manual edits only ever
// happen *together with* approving (the backend's `approveStep` proposal override).
const editing = ref(false)
const draftProposal = ref('')
function startEditing() {
  draftProposal.value = step.value?.output ?? ''
  editing.value = true
  // Editing and the review/reject path are mutually exclusive — clear the other.
  rejectArmed.value = false
  draftTarget.value = null
  void nextTick(syncHighlights)
}
function cancelEditing() {
  editing.value = false
  draftProposal.value = ''
}
async function approveWithEdits() {
  if (!ctx.value || !approvalId.value || submitting.value) return
  submitting.value = true
  try {
    await execution.approveStep(ctx.value.instanceId, approvalId.value, draftProposal.value)
    close()
  } finally {
    submitting.value = false
  }
}
async function requestChanges() {
  if (!ctx.value || !approvalId.value || submitting.value || !canRequestChanges.value) return
  submitting.value = true
  try {
    await execution.requestStepChanges(ctx.value.instanceId, approvalId.value, {
      feedback: feedback.value.trim() || undefined,
      comments: reviewComments.value.length
        ? reviewComments.value.map((c) => ({
            quotedSource: c.quotedSource,
            srcStart: c.srcStart,
            srcEnd: c.srcEnd,
            body: c.body,
          }))
        : undefined,
    })
    close()
  } finally {
    submitting.value = false
  }
}
// Reject stops the whole run, so it's a two-step inline confirm (no native dialog,
// consistent with the rest of the Nuxt-UI surface): `armReject` reveals the confirm
// row, `reject` performs it.
const rejectArmed = ref(false)
function armReject() {
  rejectArmed.value = true
}
function disarmReject() {
  rejectArmed.value = false
}
async function reject() {
  if (!ctx.value || !approvalId.value || submitting.value) return
  submitting.value = true
  try {
    await execution.rejectStep(
      ctx.value.instanceId,
      approvalId.value,
      feedback.value.trim() || undefined,
    )
    close()
  } finally {
    submitting.value = false
    rejectArmed.value = false
  }
}

// Keep the in-document highlights in sync as the output renders or comments change.
watch(
  [approvalPending, () => step.value?.output, reviewComments, draftTarget],
  () => void nextTick(syncHighlights),
  { deep: true },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="reader-fade">
      <div
        v-if="open && step && agent"
        class="fixed inset-0 z-50 flex bg-slate-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <!-- ToC sidebar (only meaningful when there are prose headings) -->
        <aside
          v-if="outline.hasToc"
          class="hidden w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-900/60 md:flex"
        >
          <div class="border-b border-slate-800 px-4 py-3">
            <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Contents
            </div>
          </div>
          <nav class="flex-1 space-y-0.5 overflow-auto px-2 py-3">
            <button
              class="block w-full truncate rounded-md px-2 py-1 text-left text-[13px] transition"
              :class="
                activeId === 'step-details'
                  ? 'bg-indigo-500/15 font-medium text-indigo-200'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              "
              @click="goTo('step-details')"
            >
              Details
            </button>
            <button
              v-for="s in tocSections"
              :key="s.id"
              class="block w-full truncate rounded-md px-2 py-1 text-left text-[13px] transition"
              :class="
                activeId === s.id
                  ? 'bg-indigo-500/15 font-medium text-indigo-200'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              "
              :style="{ paddingLeft: `${(s.depth - outline.minDepth) * 0.85 + 0.5}rem` }"
              :title="s.title"
              @click="goTo(s.id)"
            >
              {{ s.title }}
            </button>
          </nav>
        </aside>

        <!-- main column -->
        <div class="flex min-w-0 flex-1 flex-col">
          <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
            <div
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              :style="{ backgroundColor: agent.color + '22' }"
            >
              <UIcon :name="agent.icon" class="h-5 w-5" :style="{ color: agent.color }" />
            </div>
            <div class="min-w-0">
              <h1 class="truncate text-base font-semibold text-white">{{ agent.label }}</h1>
              <p v-if="block" class="truncate text-xs text-slate-500">{{ block.title }}</p>
            </div>
            <div class="ml-auto flex items-center gap-1.5">
              <UBadge
                v-if="approvalPending"
                color="warning"
                variant="subtle"
                size="sm"
                class="mr-1"
              >
                <UIcon name="i-lucide-shield-check" class="mr-1 h-3 w-3" />
                Approval required
              </UBadge>
              <UButton
                v-if="outline.sections.length"
                :icon="allCollapsed ? 'i-lucide-unfold-vertical' : 'i-lucide-fold-vertical'"
                color="neutral"
                variant="ghost"
                size="sm"
                :title="allCollapsed ? 'Expand all sections' : 'Collapse all sections'"
                @click="setAll(!allCollapsed)"
              />
              <UButton
                v-if="hasOutput"
                icon="i-lucide-copy"
                color="neutral"
                variant="ghost"
                size="sm"
                title="Copy raw output"
                @click="copyOutput"
              />
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="sm"
                title="Close (Esc)"
                @click="close"
              />
            </div>
          </header>

          <div ref="scrollEl" class="flex-1 overflow-auto px-6 py-6" @scroll="onScroll">
            <div class="mx-auto max-w-3xl space-y-5">
              <!-- metadata card (always shown) -->
              <section
                id="step-details"
                :ref="(el) => (sectionEls['step-details'] = el as HTMLElement | null)"
                class="scroll-mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4"
              >
                <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">State</dt>
                    <dd class="mt-0.5 flex items-center gap-1.5 text-slate-200">
                      <span
                        class="h-2 w-2 rounded-full"
                        :style="{ backgroundColor: STATE_META[step.state].color }"
                      />
                      {{ STATE_META[step.state].label }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">Duration</dt>
                    <dd class="mt-0.5 flex items-center gap-1.5 tabular-nums text-slate-200">
                      <UIcon
                        v-if="isRunning"
                        name="i-lucide-loader-circle"
                        class="h-3 w-3 animate-spin text-indigo-400"
                      />
                      <span v-if="durationLabel">{{ durationLabel }}</span>
                      <span v-else class="text-slate-500">—</span>
                      <span v-if="isRunning" class="text-[11px] text-slate-500">elapsed</span>
                    </dd>
                  </div>
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">Step</dt>
                    <dd class="mt-0.5 text-slate-200">{{ stepNumber }} of {{ totalSteps }}</dd>
                  </div>
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">Started</dt>
                    <dd class="mt-0.5 text-slate-300">{{ formatClock(step.startedAt) ?? '—' }}</dd>
                  </div>
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">Finished</dt>
                    <dd class="mt-0.5 text-slate-300">{{ formatClock(step.finishedAt) ?? '—' }}</dd>
                  </div>
                  <div>
                    <dt class="text-[11px] uppercase tracking-wide text-slate-500">Model</dt>
                    <dd class="mt-0.5 truncate text-slate-300" :title="step.model">
                      {{ modelLabel ?? 'Not recorded' }}
                    </dd>
                  </div>
                </dl>

                <!-- container cold-boot phase: shown until the container is up and
                     the agent starts reporting progress -->
                <div
                  v-if="step.startingContainer && !runFailed"
                  class="mt-4 flex items-center gap-2 rounded-lg border border-sky-900/50 bg-sky-950/30 px-3 py-2 text-[12px] text-sky-300"
                >
                  <UIcon name="i-lucide-loader-circle" class="h-4 w-4 shrink-0 animate-spin" />
                  <span>Spinning up container…</span>
                </div>

                <!-- live subtask breakdown -->
                <div v-if="step.subtasks && step.subtasks.total > 0" class="mt-4">
                  <div class="text-[11px] uppercase tracking-wide text-slate-500">
                    Subtasks · {{ step.subtasks.completed }}/{{ step.subtasks.total }}
                  </div>
                  <div class="mt-1 h-1 overflow-hidden rounded-full bg-slate-700/60">
                    <div
                      class="h-full rounded-full bg-indigo-400 transition-all duration-500"
                      :style="{
                        width: `${(step.subtasks.completed / step.subtasks.total) * 100}%`,
                      }"
                    />
                  </div>
                  <ul v-if="step.subtasks.items?.length" class="mt-2 space-y-1">
                    <li
                      v-for="(item, idx) in step.subtasks.items"
                      :key="idx"
                      class="flex items-start gap-1.5 text-[12px]"
                      :class="
                        item.status === 'completed'
                          ? 'text-slate-500 line-through'
                          : item.status === 'in_progress'
                            ? 'text-slate-100'
                            : 'text-slate-400'
                      "
                    >
                      <UIcon
                        :name="ITEM_ICON[item.status]"
                        class="mt-px h-3 w-3 shrink-0"
                        :class="subtaskIconClass(item.status, runFailed)"
                      />
                      <span>{{ item.label }}</span>
                    </li>
                  </ul>
                </div>

                <!-- LLM observability rollup (tokens, output-limit headroom,
                     transport-vs-execution); click to open the full per-call panel -->
                <div v-if="step.metrics && step.metrics.calls > 0" class="mt-4">
                  <div class="mb-1 flex items-center justify-between">
                    <span class="text-[11px] uppercase tracking-wide text-slate-500">
                      Model activity
                    </span>
                    <button
                      class="text-[11px] text-sky-400 hover:text-sky-300"
                      @click="ctx && ui.openObservability(ctx.instanceId)"
                    >
                      View all calls →
                    </button>
                  </div>
                  <StepMetricsBar
                    :metrics="step.metrics"
                    clickable
                    @inspect="ctx && ui.openObservability(ctx.instanceId)"
                  />
                </div>

                <!-- standards (prompt fragments) folded into this step -->
                <div
                  v-if="step.selectedFragmentIds && step.selectedFragmentIds.length"
                  class="mt-4"
                >
                  <div class="text-[11px] uppercase tracking-wide text-slate-500">
                    Standards applied
                  </div>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <UBadge
                      v-for="id in step.selectedFragmentIds"
                      :key="id"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                    >
                      {{ id }}
                    </UBadge>
                  </div>
                </div>

                <!-- decision raised on this step -->
                <div v-if="step.decision" class="mt-4">
                  <div class="text-[11px] uppercase tracking-wide text-slate-500">Decision</div>
                  <p class="mt-0.5 text-[13px] text-slate-200">{{ step.decision.question }}</p>
                  <p
                    v-if="step.decision.chosen"
                    class="mt-0.5 flex items-center gap-1 text-[12px] text-emerald-400"
                  >
                    <UIcon name="i-lucide-check" class="h-3 w-3 shrink-0" />
                    {{ step.decision.chosen }}
                  </p>
                  <p v-else class="mt-0.5 text-[12px] text-amber-400">Awaiting a human choice</p>
                </div>

                <!-- approval gate state -->
                <div v-if="step.approval" class="mt-4">
                  <div class="text-[11px] uppercase tracking-wide text-slate-500">
                    Approval gate
                  </div>
                  <p class="mt-0.5 text-[13px] text-slate-200 capitalize">
                    {{ step.approval.status.replace('_', ' ') }}
                  </p>
                </div>
              </section>

              <!-- edit-then-approve: a direct editor over the raw conclusions; the
                   edits become the approved proposal that flows to the next step -->
              <section v-if="editing" class="scroll-mt-4">
                <div class="mb-2 flex items-center gap-1.5 text-[11px] text-amber-400">
                  <UIcon name="i-lucide-pencil" class="h-3.5 w-3.5" />
                  <span class="font-semibold uppercase tracking-wide">Editing the conclusions</span>
                </div>
                <UTextarea
                  v-model="draftProposal"
                  :rows="22"
                  autoresize
                  size="sm"
                  class="w-full"
                  :ui="{ base: 'font-mono text-[12px] leading-relaxed' }"
                  placeholder="Edit the agent's conclusions; your edits are saved when you approve…"
                />
              </section>

              <!-- the agent's prose output, sectioned + collapsible -->
              <template v-else-if="hasOutput">
                <section
                  v-for="s in outline.sections"
                  :id="s.id"
                  :key="s.id"
                  :ref="(el) => (sectionEls[s.id] = el as HTMLElement | null)"
                  class="scroll-mt-4"
                >
                  <button
                    v-if="s.depth > 0"
                    class="group flex w-full items-center gap-2 rounded-md py-1 text-left transition hover:text-white"
                    @click="toggle(s.id)"
                  >
                    <UIcon
                      name="i-lucide-chevron-right"
                      class="h-4 w-4 shrink-0 text-slate-500 transition-transform group-hover:text-slate-300"
                      :class="collapsed[s.id] ? '' : 'rotate-90'"
                    />
                    <span
                      class="font-semibold text-slate-100"
                      :class="s.depth <= 1 ? 'text-lg' : s.depth === 2 ? 'text-base' : 'text-sm'"
                      v-html="s.titleHtml"
                    />
                  </button>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-show="!collapsed[s.id]"
                    class="reader-prose mt-1 text-[13px] leading-relaxed text-slate-300"
                    :class="[
                      s.depth > 0 ? 'pl-6' : '',
                      approvalPending && !editing ? 'review-mode' : '',
                    ]"
                    @click="onProseClick"
                    v-html="s.bodyHtml"
                  />
                </section>
              </template>

              <p
                v-else
                class="rounded-lg border border-dashed border-slate-800 py-6 text-center text-sm text-slate-500"
              >
                This agent produced no prose output.
              </p>
            </div>
          </div>
        </div>

        <!-- review rail (approval mode): per-block comments + overall feedback +
             Approve / Request changes / Reject. A right-side rail on wide screens; a
             bottom sheet (still reachable) below lg, so the gate is always actionable. -->
        <aside
          v-if="approvalPending"
          class="absolute inset-x-0 bottom-0 z-10 flex max-h-[70vh] flex-col rounded-t-2xl border-t border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur lg:static lg:inset-auto lg:z-auto lg:max-h-none lg:w-96 lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:border-slate-800 lg:bg-slate-900/60 lg:shadow-none lg:backdrop-blur-none"
        >
          <div class="border-b border-slate-800 px-4 py-3">
            <div class="text-[11px] font-semibold uppercase tracking-wide text-amber-400">
              {{ editing ? 'Approve with corrections' : 'Review & approve' }}
            </div>
            <p class="mt-1 text-[12px] text-slate-400">
              {{
                editing
                  ? 'Edit the conclusions on the left; your edits are saved when you approve.'
                  : 'Click any block in the output to comment on it, or leave overall feedback below.'
              }}
            </p>
          </div>

          <div class="flex-1 space-y-3 overflow-auto px-4 py-3">
            <p
              v-if="editing"
              class="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] leading-relaxed text-amber-200/90"
            >
              You're editing the conclusions directly. Manual edits can't be combined with per-block
              comments — approve to save them, or cancel to return to review.
            </p>
            <template v-else>
              <!-- composer for the block the human just clicked -->
              <div
                v-if="draftTarget"
                class="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-3"
              >
                <div class="mb-1 text-[10px] uppercase tracking-wide text-indigo-300">
                  Commenting on
                </div>
                <pre
                  class="mb-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-2 text-[11px] text-slate-300"
                  >{{ draftTarget.quotedSource }}</pre
                >
                <UTextarea
                  v-model="draftBody"
                  :rows="3"
                  autoresize
                  size="sm"
                  class="w-full"
                  placeholder="Leave a comment on this block…"
                />
                <div class="mt-2 flex justify-end gap-2">
                  <UButton color="neutral" variant="ghost" size="xs" @click="cancelDraft">
                    Cancel
                  </UButton>
                  <UButton
                    color="primary"
                    size="xs"
                    :disabled="!draftBody.trim()"
                    @click="addDraftComment"
                  >
                    Add comment
                  </UButton>
                </div>
              </div>

              <!-- comments added so far -->
              <div
                v-for="(c, idx) in reviewComments"
                :key="idx"
                class="rounded-lg border border-slate-800 bg-slate-900/50 p-3"
              >
                <div class="mb-1 flex items-start justify-between gap-2">
                  <div class="text-[10px] uppercase tracking-wide text-slate-500">
                    Comment {{ idx + 1 }}
                  </div>
                  <button
                    class="text-slate-500 transition hover:text-rose-400"
                    title="Remove comment"
                    @click="removeComment(idx)"
                  >
                    <UIcon name="i-lucide-x" class="h-3.5 w-3.5" />
                  </button>
                </div>
                <pre
                  class="mb-1 max-h-20 overflow-auto whitespace-pre-wrap rounded bg-slate-950/50 p-1.5 text-[10px] text-slate-400"
                  >{{ c.quotedSource }}</pre
                >
                <p class="text-[12px] text-slate-200">{{ c.body }}</p>
              </div>

              <div>
                <label
                  class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                >
                  Overall feedback / reject reason
                </label>
                <UTextarea
                  v-model="feedback"
                  :rows="3"
                  autoresize
                  size="sm"
                  class="w-full"
                  placeholder="Describe the changes the agent should make (optional if you left per-block comments)…"
                />
              </div>
            </template>
          </div>

          <!-- edit-then-approve actions -->
          <div v-if="editing" class="space-y-2 border-t border-slate-800 px-4 py-3">
            <UButton
              color="primary"
              size="sm"
              icon="i-lucide-check"
              block
              :loading="submitting"
              @click="approveWithEdits"
            >
              Approve with these edits
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              block
              :disabled="submitting"
              @click="cancelEditing"
            >
              Cancel edits
            </UButton>
          </div>

          <div v-else class="space-y-2 border-t border-slate-800 px-4 py-3">
            <UButton
              color="primary"
              size="sm"
              icon="i-lucide-check"
              block
              :disabled="rejectArmed"
              :loading="submitting"
              @click="approve"
            >
              Approve &amp; proceed
            </UButton>
            <UButton
              color="primary"
              variant="soft"
              size="sm"
              icon="i-lucide-pencil"
              block
              :disabled="rejectArmed || submitting"
              @click="startEditing"
            >
              Approve with corrections
            </UButton>

            <!-- destructive: a two-step inline confirm instead of a native dialog -->
            <div
              v-if="rejectArmed"
              class="rounded-lg border border-rose-500/40 bg-rose-500/5 p-2.5"
            >
              <p class="mb-2 text-[11px] text-rose-200">
                Reject this proposal and stop the run entirely?
              </p>
              <div class="flex gap-2">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="flex-1"
                  :disabled="submitting"
                  @click="disarmReject"
                >
                  Cancel
                </UButton>
                <UButton
                  color="error"
                  size="xs"
                  icon="i-lucide-ban"
                  class="flex-1"
                  :loading="submitting"
                  @click="reject"
                >
                  Confirm reject
                </UButton>
              </div>
            </div>
            <div v-else class="flex gap-2">
              <UButton
                color="warning"
                variant="soft"
                size="sm"
                icon="i-lucide-rotate-ccw"
                class="flex-1"
                :disabled="!canRequestChanges"
                :loading="submitting"
                @click="requestChanges"
              >
                Request changes
              </UButton>
              <UButton
                color="error"
                variant="soft"
                size="sm"
                icon="i-lucide-ban"
                class="flex-1"
                :disabled="submitting"
                @click="armReject"
              >
                Reject
              </UButton>
            </div>
            <p class="text-[10px] text-slate-500">
              Request changes re-runs this step with your feedback &amp; comments. Reject stops the
              run entirely.
            </p>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.reader-fade-enter-active,
.reader-fade-leave-active {
  transition: opacity 0.18s ease;
}
.reader-fade-enter-from,
.reader-fade-leave-to {
  opacity: 0;
}

/* Approval mode: each source-mapped block becomes a comment target — a hover
   highlight + a "+" gutter affordance, GitHub-review style. */
.reader-prose.review-mode :deep([data-src-start]) {
  position: relative;
  cursor: pointer;
  border-radius: 0.375rem;
  transition: background 0.12s ease;
}
.reader-prose.review-mode :deep([data-src-start]:hover) {
  background: rgb(99 102 241 / 0.08);
  box-shadow: inset 2px 0 0 rgb(99 102 241 / 0.5);
}
.reader-prose.review-mode :deep([data-src-start])::before {
  content: '+';
  position: absolute;
  left: -1.4rem;
  top: 0.1rem;
  display: none;
  height: 1.1rem;
  width: 1.1rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.25rem;
  background: rgb(99 102 241);
  color: white;
  font-size: 0.8rem;
  line-height: 1;
}
.reader-prose.review-mode :deep([data-src-start]:hover)::before {
  display: flex;
}
/* Persistent markers: amber for a block that already has a comment, indigo for
   the block whose composer is currently open. */
.reader-prose :deep(.cf-commented) {
  background: rgb(234 179 8 / 0.1);
  box-shadow: inset 2px 0 0 rgb(234 179 8 / 0.6);
}
.reader-prose :deep(.cf-selected) {
  background: rgb(99 102 241 / 0.12);
  box-shadow: inset 2px 0 0 rgb(99 102 241 / 0.8);
}

/* Styling for the markdown HTML injected via v-html (out of scoped reach without
   :deep), kept close to the inspector's existing prose styling. */
.reader-prose :deep(p) {
  margin: 0.5rem 0;
}
.reader-prose :deep(ul),
.reader-prose :deep(ol) {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}
.reader-prose :deep(ul) {
  list-style: disc;
}
.reader-prose :deep(ol) {
  list-style: decimal;
}
.reader-prose :deep(li) {
  margin: 0.2rem 0;
}
.reader-prose :deep(strong) {
  font-weight: 600;
  color: rgb(226 232 240);
}
.reader-prose :deep(em) {
  font-style: italic;
}
.reader-prose :deep(code) {
  border-radius: 0.25rem;
  background: rgb(30 41 59 / 0.8);
  padding: 0.1rem 0.3rem;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  color: rgb(199 210 254);
}
.reader-prose :deep(pre) {
  margin: 0.6rem 0;
  overflow: auto;
  border-radius: 0.5rem;
  background: rgb(2 6 23 / 0.6);
  padding: 0.75rem 0.9rem;
}
.reader-prose :deep(pre code) {
  background: transparent;
  padding: 0;
  color: rgb(203 213 225);
}
.reader-prose :deep(blockquote) {
  margin: 0.6rem 0;
  border-left: 3px solid rgb(99 102 241 / 0.5);
  padding-left: 0.75rem;
  color: rgb(148 163 184);
}
.reader-prose :deep(table) {
  margin: 0.6rem 0;
  border-collapse: collapse;
  font-size: 0.95em;
}
.reader-prose :deep(th),
.reader-prose :deep(td) {
  border: 1px solid rgb(51 65 85);
  padding: 0.3rem 0.6rem;
}
.reader-prose :deep(th) {
  background: rgb(30 41 59 / 0.6);
  font-weight: 600;
}
.reader-prose :deep(hr) {
  margin: 1rem 0;
  border: none;
  border-top: 1px solid rgb(51 65 85);
}
.reader-prose :deep(h1),
.reader-prose :deep(h2),
.reader-prose :deep(h3),
.reader-prose :deep(h4) {
  margin: 0.6rem 0 0.3rem;
  font-weight: 600;
  color: rgb(226 232 240);
}
</style>
