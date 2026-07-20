<script setup lang="ts">
// PR deep-review window — the dedicated surface for the read-only `pr-reviewer`'s sliced,
// prioritized findings, opened via the universal result-view host. It reads the live review
// state straight off the run's `pr-reviewer` step (`step.prReview`, kept fresh by the
// execution stream) and lets a human multi-SELECT which findings matter, grouped by slice and
// sorted by severity, then resolve the review one of three ways: `Fix` (feed the selected
// findings to a Fixer that commits fixes onto the PR branch), `Post` (publish them as inline PR
// review comments), or `Finish` (just record the curated selection). Fix/Post act on the
// selection, so they require at least one selected finding.
import { computed, ref, watch } from 'vue'
import { useResultView } from '~/composables/useResultView'
import { useExecutionStore } from '~/stores/execution'
import { useBoardStore } from '~/stores/board'
import { usePrReviewStore } from '~/stores/prReview'
import type {
  PrReviewFinding,
  PrReviewResolution,
  PrReviewSeverity,
  PrReviewStepState,
  StepSubtasks,
} from '~/types/execution'
import { subtaskIconClass } from '~/utils/pipelineRender'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'

const execution = useExecutionStore()
const board = useBoardStore()
const prReview = usePrReviewStore()
const access = useWorkspaceAccess()

const { t } = useI18n()

const { open, blockId, instanceId, stepIndex, close } = useResultView('pr-review', {
  onOpen: ({ instanceId }) => {
    if (instanceId) void prReview.load(instanceId)
  },
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const state = computed<PrReviewStepState | null>(() => step.value?.prReview ?? null)
const status = computed(() => state.value?.status ?? null)
const awaiting = computed(() => status.value === 'awaiting_selection')
// A finding is being re-examined by the Challenge Investigator (the whole review is `challenging`
// while it runs). The findings stay visible — the challenged one shows a spinner — but the
// selection controls + per-finding actions are disabled until the verdict lands and it re-parks.
const challenging = computed(() => status.value === 'challenging')
// The reviewer's live todo list while it works, streamed onto the step. Its entries are the
// cohesive slices/chunks the agent grouped the diff into (plus a final "aggregate" step), so it
// surfaces slices-reviewed-so-far progress during the `reviewing` phase — richer than a spinner.
const subtasks = computed<StepSubtasks | null>(() => step.value?.subtasks ?? null)
const hasProgress = computed(() => (subtasks.value?.total ?? 0) > 0)

/** Icon per todo-item status (matches the pipeline timeline's live subtask breakdown). */
const ITEM_ICON: Record<string, string> = {
  completed: 'i-lucide-check-circle-2',
  in_progress: 'i-lucide-loader-circle',
  pending: 'i-lucide-circle',
}
// A resolution is executing (the Fixer is committing, or comments are being posted) — show a
// working state between the human's choice and the run advancing/the stream echoing `done`.
const working = computed(() => status.value === 'fixing' || status.value === 'posting')
const findings = computed<PrReviewFinding[]>(() => state.value?.findings ?? [])

// The outcome of the last `post` attempt (null until one runs). A partial/failed post re-parks
// the review at `awaiting_selection` carrying this, so the human sees what posted / what failed
// and can retry ONLY the posting rather than re-running the whole review.
const postReport = computed(() => state.value?.postReport ?? null)
const postedIds = computed(() => new Set(state.value?.postedFindingIds ?? []))

/** Severity → chip classes (styling, not copy). */
const SEVERITY_CLASS: Record<PrReviewSeverity, string> = {
  blocker: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  high: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  medium: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  low: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  nit: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
}

/** Findings grouped under their slice (in the review's slice order), plus an "Other" bucket. */
const groups = computed(() => {
  const slices = state.value?.slices ?? []
  const byId = new Map<string, PrReviewFinding[]>()
  const unsliced: PrReviewFinding[] = []
  for (const f of findings.value) {
    if (f.sliceId && slices.some((s) => s.id === f.sliceId)) {
      const arr = byId.get(f.sliceId) ?? []
      arr.push(f)
      byId.set(f.sliceId, arr)
    } else {
      unsliced.push(f)
    }
  }
  const out = slices
    .map((s) => ({ id: s.id, title: s.title, rationale: s.rationale, items: byId.get(s.id) ?? [] }))
    .filter((g) => g.items.length > 0)
  if (unsliced.length > 0) {
    out.push({ id: '__unsliced', title: t('prReview.unsliced'), rationale: '', items: unsliced })
  }
  return out
})

/** A finding the Challenge Investigator RETRACTED — it can no longer be acted on (auto-deselected). */
function isRetracted(f: PrReviewFinding): boolean {
  return f.challenge?.status === 'retracted'
}
/** A finding currently being re-examined by the Challenge Investigator. */
function isInvestigating(f: PrReviewFinding): boolean {
  return f.challenge?.status === 'investigating'
}
/** A finding the investigator UPHELD + strengthened after a challenge (its body actually changed). */
function isAmended(f: PrReviewFinding): boolean {
  return f.challenge?.status === 'amended'
}
/** A finding the investigator UPHELD as written after a challenge (kept, no revision). */
function isUpheld(f: PrReviewFinding): boolean {
  return f.challenge?.status === 'upheld'
}
/** A finding whose challenge investigation FAILED — the finding is kept as-is; re-challenge allowed. */
function isChallengeFailed(f: PrReviewFinding): boolean {
  return f.challenge?.status === 'failed'
}

// The human's selection — a set of finding ids. Defaults to every finding (the human deselects
// the noise), so "Finish" without touching anything keeps all. Re-seeded ONLY when the set of
// finding IDS actually changes — NOT on every execution-stream re-emit (which hands us a fresh
// `findings` array reference on each reconnect/resync). Keying on the id set keeps the human's
// in-progress curation from being silently reset by an unrelated live update.
const findingIdKey = computed(() => findings.value.map((f) => f.id).join('\n'))
const selected = ref<Set<string>>(new Set())
watch(
  findingIdKey,
  () => {
    selected.value = new Set(findings.value.filter((f) => !isRetracted(f)).map((f) => f.id))
  },
  { immediate: true },
)

// The effective selection: checked AND not retracted. A retracted finding is never acted on even
// if its box was checked before the investigator dropped it (it's disabled + unchecked visually).
const activeSelectedIds = computed(() =>
  findings.value.filter((f) => selected.value.has(f.id) && !isRetracted(f)).map((f) => f.id),
)

function toggle(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
function selectAll(): void {
  selected.value = new Set(findings.value.filter((f) => !isRetracted(f)).map((f) => f.id))
}
function clearAll(): void {
  selected.value = new Set()
}

const canResolve = computed(() => awaiting.value && !prReview.resolving)
// Fix / Post act on the selection, so they need at least one selected finding; Finish always
// works (it just records the — possibly empty — curated selection and completes the review).
const hasSelection = computed(() => activeSelectedIds.value.length > 0)

async function onResolve(action: PrReviewResolution): Promise<void> {
  const id = instanceId.value
  if (!id || !canResolve.value) return
  if ((action === 'fix' || action === 'post') && !hasSelection.value) return
  await prReview.resolve(id, activeSelectedIds.value, action).catch(() => {})
}

// Per-finding CHALLENGE: the open finding's id (its inline concern box is showing) + the drafted
// concern text. Dispatching moves the whole review to `challenging` until the verdict lands.
const challengeForId = ref<string | null>(null)
const challengeText = ref('')
function openChallenge(id: string): void {
  challengeForId.value = id
  challengeText.value = ''
}
function cancelChallenge(): void {
  challengeForId.value = null
  challengeText.value = ''
}
async function submitChallenge(id: string): Promise<void> {
  const inst = instanceId.value
  if (!inst || !canResolve.value) return
  const question = challengeText.value.trim()
  challengeForId.value = null
  challengeText.value = ''
  await prReview.challenge(inst, id, question || undefined).catch(() => {})
}
async function onDismiss(id: string): Promise<void> {
  const inst = instanceId.value
  if (!inst || !canResolve.value) return
  if (challengeForId.value === id) cancelChallenge()
  await prReview.dismiss(inst, id).catch(() => {})
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-clipboard-check"
    icon-class="bg-indigo-500/15 text-indigo-300"
    :title="block ? t('prReview.titleWithBlock', { title: block.title }) : t('prReview.title')"
    :subtitle="t('prReview.subtitle')"
    width="3xl"
    testid="pr-review-window"
    @close="close"
  >
    <template v-if="state?.prUrl" #header-extras>
      <a
        :href="state.prUrl"
        target="_blank"
        rel="noopener"
        class="rounded-md px-2 py-1 text-[11px] text-indigo-300 hover:bg-slate-800"
      >
        {{ t('prReview.openPr') }}
      </a>
    </template>

    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <!-- Reviewing: the read-only reviewer is still working. Once it starts maintaining its
           per-slice todo list, surface the live chunk progress (slices reviewed / total + the
           breakdown) instead of a bare spinner. -->
      <div
        v-if="status === 'reviewing'"
        data-testid="pr-review-reviewing"
        class="flex h-full flex-col"
      >
        <!-- Live chunk progress once the reviewer has planned its slices. -->
        <div v-if="hasProgress" class="py-2">
          <div class="mb-1 flex items-center gap-2 text-sm text-slate-200">
            <UIcon
              name="i-lucide-loader-circle"
              class="h-4 w-4 shrink-0 animate-spin text-indigo-300"
            />
            <span>{{ t('prReview.reviewing.title') }}</span>
          </div>
          <p class="mb-3 text-[11px] text-slate-500">{{ t('prReview.reviewing.hint') }}</p>

          <div class="flex items-center justify-between text-[11px] text-slate-400">
            <span data-testid="pr-review-chunk-count">
              {{
                t('prReview.reviewing.chunks', {
                  completed: subtasks!.completed,
                  total: subtasks!.total,
                })
              }}
            </span>
            <span v-if="subtasks!.inProgress > 0" class="text-indigo-300">
              {{ t('prReview.reviewing.inProgress', { count: subtasks!.inProgress }) }}
            </span>
          </div>
          <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-700/60">
            <div
              class="h-full rounded-full bg-indigo-400 transition-all duration-500"
              :style="{ width: `${(subtasks!.completed / subtasks!.total) * 100}%` }"
            />
          </div>

          <!-- The slice/todo breakdown the agent is working through. -->
          <ul
            v-if="subtasks!.items?.length"
            class="mt-3 space-y-1.5"
            data-testid="pr-review-chunks"
          >
            <li
              v-for="(item, i) in subtasks!.items"
              :key="i"
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
                class="mt-0.5 h-3.5 w-3.5 shrink-0"
                :class="subtaskIconClass(item.status, false)"
              />
              <span>{{ item.label }}</span>
            </li>
          </ul>
        </div>

        <!-- Before the reviewer has planned its slices: the cold-start spinner. -->
        <div
          v-else
          class="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-slate-400"
        >
          <UIcon name="i-lucide-loader-circle" class="h-8 w-8 animate-spin opacity-60" />
          <p class="text-sm">{{ t('prReview.reviewing.title') }}</p>
          <p class="max-w-sm text-[11px] text-slate-500">{{ t('prReview.reviewing.hint') }}</p>
        </div>
      </div>

      <!-- A resolution is executing: the Fixer is committing / comments are being posted. -->
      <div
        v-else-if="working"
        data-testid="pr-review-working"
        class="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-slate-400"
      >
        <UIcon name="i-lucide-loader-circle" class="h-8 w-8 animate-spin opacity-60" />
        <p class="text-sm">
          {{ status === 'fixing' ? t('prReview.fixing.title') : t('prReview.posting.title') }}
        </p>
        <p class="max-w-sm text-[11px] text-slate-500">
          {{ status === 'fixing' ? t('prReview.fixing.hint') : t('prReview.posting.hint') }}
        </p>
      </div>

      <template v-else>
        <p
          v-if="prReview.error"
          class="mb-3 rounded-md bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300"
        >
          {{ prReview.error }}
        </p>

        <!-- The outcome of the most recent `post` attempt: how many of how many comments landed,
             which failed + why, and how many findings were folded into the summary because their
             line isn't in the PR diff. Surfaced so a partial/failed post is legible + retryable. -->
        <div
          v-if="postReport"
          data-testid="pr-review-post-report"
          class="mb-3 rounded-lg border px-3 py-2 text-[12px]"
          :class="
            postReport.failures.length > 0 || postReport.bodyPosted === false
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          "
        >
          <div class="mb-1 flex items-center gap-1.5 font-medium">
            <UIcon
              :name="
                postReport.failures.length > 0 || postReport.bodyPosted === false
                  ? 'i-lucide-alert-triangle'
                  : 'i-lucide-check-circle-2'
              "
              class="h-4 w-4 shrink-0"
            />
            <span>{{ t('prReview.postReport.heading') }}</span>
          </div>
          <p data-testid="pr-review-post-count">
            {{
              t('prReview.postReport.posted', {
                posted: postReport.posted,
                attempted: postReport.attempted,
              })
            }}
          </p>
          <p v-if="postReport.folded > 0" class="mt-0.5 opacity-90">
            {{ t('prReview.postReport.folded', { count: postReport.folded }) }}
          </p>
          <template v-if="postReport.failures.length > 0">
            <p class="mt-1.5 font-medium">{{ t('prReview.postReport.failuresHeading') }}</p>
            <ul class="mt-0.5 space-y-0.5" data-testid="pr-review-post-failures">
              <li v-for="f in postReport.failures" :key="f.findingId" class="flex gap-1.5">
                <code class="shrink-0 text-amber-100"
                  >{{ f.path }}<template v-if="f.line != null">:{{ f.line }}</template></code
                >
                <span class="opacity-90">— {{ f.reason }}</span>
              </li>
            </ul>
          </template>
          <p v-if="postReport.bodyPosted === false && postReport.bodyError" class="mt-1.5">
            {{ t('prReview.postReport.bodyError', { error: postReport.bodyError }) }}
          </p>
        </div>

        <!-- The reviewer's overall assessment. -->
        <p
          v-if="state?.summary"
          class="mb-3 rounded-md bg-slate-800/50 px-3 py-2 text-[12px] text-slate-300"
        >
          <span class="text-slate-500">{{ t('prReview.summaryLabel') }}</span>
          {{ state.summary }}
        </p>

        <!-- A clean PR / resolved review with no findings. -->
        <div
          v-if="findings.length === 0"
          class="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-6 text-center text-[13px] text-slate-300"
        >
          {{ t('prReview.noFindings') }}
        </div>

        <template v-else>
          <!-- A challenge is in flight: the Challenge Investigator is re-examining a finding. -->
          <div
            v-if="challenging"
            data-testid="pr-review-challenging"
            class="mb-3 flex items-center gap-2 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-[12px] text-indigo-200"
          >
            <UIcon name="i-lucide-loader-circle" class="h-4 w-4 shrink-0 animate-spin" />
            <span>{{ t('prReview.challenge.investigatingBanner') }}</span>
          </div>

          <!-- Selection toolbar -->
          <div v-if="awaiting" class="mb-2 flex items-center gap-3 text-[11px] text-slate-400">
            <span data-testid="pr-review-selected-count">
              {{ t('prReview.selectedCount', { count: activeSelectedIds.length }) }}
            </span>
            <button class="text-indigo-300 hover:underline" @click="selectAll">
              {{ t('prReview.selectAll') }}
            </button>
            <button class="text-indigo-300 hover:underline" @click="clearAll">
              {{ t('prReview.clear') }}
            </button>
          </div>

          <!-- Findings grouped by slice -->
          <section v-for="g in groups" :key="g.id" class="mb-4">
            <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ g.title }}
            </h3>
            <p v-if="g.rationale" class="mb-1.5 text-[11px] text-slate-500">
              {{ g.rationale }}
            </p>
            <article
              v-for="f in g.items"
              :key="f.id"
              data-testid="pr-review-finding"
              class="mb-1.5 rounded-xl border px-3 py-2 transition"
              :class="[
                awaiting && selected.has(f.id) && !isRetracted(f)
                  ? 'border-indigo-500/60 bg-indigo-500/5'
                  : 'border-slate-800 bg-slate-900/60',
                isRetracted(f) ? 'opacity-60' : '',
              ]"
            >
              <div class="flex items-start gap-2">
                <input
                  v-if="awaiting || challenging"
                  type="checkbox"
                  class="mt-1 accent-indigo-500"
                  data-testid="pr-review-finding-toggle"
                  :checked="selected.has(f.id) && !isRetracted(f)"
                  :disabled="!awaiting || isRetracted(f)"
                  @change="toggle(f.id)"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span
                      class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1"
                      :class="SEVERITY_CLASS[f.severity]"
                    >
                      {{ t(`prReview.severity.${f.severity}`) }}
                    </span>
                    <span class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                      {{ t(`prReview.category.${f.category}`) }}
                    </span>
                    <span
                      v-if="postedIds.has(f.id)"
                      data-testid="pr-review-finding-posted"
                      class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-300 ring-1 ring-emerald-500/30"
                    >
                      {{ t('prReview.postReport.postedBadge') }}
                    </span>
                    <!-- Challenge outcome badges -->
                    <span
                      v-if="isRetracted(f)"
                      data-testid="pr-review-finding-retracted"
                      class="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-300 ring-1 ring-rose-500/30"
                    >
                      {{ t('prReview.challenge.retractedBadge') }}
                    </span>
                    <span
                      v-else-if="isAmended(f)"
                      data-testid="pr-review-finding-amended"
                      class="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-300 ring-1 ring-sky-500/30"
                    >
                      {{ t('prReview.challenge.strengthenedBadge') }}
                    </span>
                    <span
                      v-else-if="isUpheld(f)"
                      data-testid="pr-review-finding-upheld"
                      class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-300 ring-1 ring-emerald-500/30"
                    >
                      {{ t('prReview.challenge.upheldBadge') }}
                    </span>
                    <span
                      v-else-if="isChallengeFailed(f)"
                      data-testid="pr-review-finding-challenge-failed"
                      class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300 ring-1 ring-amber-500/30"
                    >
                      {{ t('prReview.challenge.failedBadge') }}
                    </span>
                    <span
                      v-else-if="isInvestigating(f)"
                      data-testid="pr-review-finding-investigating"
                      class="flex items-center gap-1 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-300 ring-1 ring-indigo-500/30"
                    >
                      <UIcon name="i-lucide-loader-circle" class="h-3 w-3 animate-spin" />
                      {{ t('prReview.challenge.investigatingBadge') }}
                    </span>
                    <h4
                      class="min-w-0 flex-1 text-[13px] font-medium text-slate-100"
                      :class="isRetracted(f) ? 'line-through' : ''"
                    >
                      {{ f.title }}
                    </h4>
                  </div>
                  <p class="mt-0.5 text-[11px] text-slate-500">
                    {{ f.path
                    }}<template v-if="f.line != null">
                      · {{ t('prReview.line', { line: f.line }) }}</template
                    >
                  </p>
                  <p
                    class="mt-1 whitespace-pre-wrap text-[12px] text-slate-300"
                    :class="isRetracted(f) ? 'line-through' : ''"
                  >
                    {{ f.detail }}
                  </p>
                  <p
                    v-if="f.suggestedFix"
                    class="mt-1 whitespace-pre-wrap rounded-md bg-slate-800/50 px-2 py-1 text-[11px] text-slate-300"
                  >
                    <span class="text-slate-500">{{ t('prReview.suggestedFix') }}</span>
                    {{ f.suggestedFix }}
                  </p>

                  <!-- The investigator's justification (why the finding holds up / was retracted),
                       or the reason the challenge investigation failed. -->
                  <p
                    v-if="f.challenge?.justification"
                    data-testid="pr-review-finding-justification"
                    class="mt-1.5 whitespace-pre-wrap rounded-md px-2 py-1 text-[11px]"
                    :class="
                      isRetracted(f)
                        ? 'bg-rose-500/10 text-rose-200'
                        : isChallengeFailed(f)
                          ? 'bg-amber-500/10 text-amber-200'
                          : 'bg-sky-500/10 text-sky-200'
                    "
                  >
                    <span class="font-medium">{{
                      isChallengeFailed(f)
                        ? t('prReview.challenge.failedLabel')
                        : t('prReview.challenge.verdictLabel')
                    }}</span>
                    {{ f.challenge.justification }}
                  </p>

                  <!-- Per-finding actions: Challenge + Dismiss (only while awaiting a selection). -->
                  <div
                    v-if="awaiting && !isInvestigating(f)"
                    class="mt-1.5 flex items-center gap-3 text-[11px]"
                  >
                    <button
                      v-if="!isRetracted(f)"
                      data-testid="pr-review-finding-challenge"
                      class="flex items-center gap-1 text-indigo-300 hover:underline disabled:opacity-50"
                      :disabled="!canResolve || !access.canExecuteRuns.value"
                      @click="openChallenge(f.id)"
                    >
                      <UIcon name="i-lucide-gavel" class="h-3.5 w-3.5" />
                      {{
                        f.challenge
                          ? t('prReview.challenge.reChallenge')
                          : t('prReview.challenge.action')
                      }}
                    </button>
                    <button
                      data-testid="pr-review-finding-dismiss"
                      class="flex items-center gap-1 text-slate-400 hover:text-rose-300 hover:underline disabled:opacity-50"
                      :disabled="!canResolve || !access.canExecuteRuns.value"
                      @click="onDismiss(f.id)"
                    >
                      <UIcon name="i-lucide-trash-2" class="h-3.5 w-3.5" />
                      {{ t('prReview.challenge.dismiss') }}
                    </button>
                  </div>

                  <!-- The inline challenge box: an OPTIONAL specific concern for the investigator. -->
                  <div
                    v-if="challengeForId === f.id"
                    data-testid="pr-review-challenge-box"
                    class="mt-2 rounded-md border border-indigo-500/40 bg-slate-900/80 p-2"
                  >
                    <textarea
                      v-model="challengeText"
                      data-testid="pr-review-challenge-input"
                      rows="2"
                      :placeholder="t('prReview.challenge.placeholder')"
                      class="w-full resize-y rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-[12px] text-slate-200 outline-none focus:border-indigo-500"
                    />
                    <p class="mt-1 text-[10px] text-slate-500">
                      {{ t('prReview.challenge.hint') }}
                    </p>
                    <div class="mt-1.5 flex justify-end gap-2">
                      <button
                        class="rounded px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
                        @click="cancelChallenge"
                      >
                        {{ t('common.cancel') }}
                      </button>
                      <button
                        data-testid="pr-review-challenge-submit"
                        class="rounded bg-indigo-500/80 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                        :disabled="!canResolve"
                        @click="submitChallenge(f.id)"
                      >
                        {{ t('prReview.challenge.submit') }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </section>
        </template>
      </template>
    </div>

    <!-- Footer -->
    <footer
      v-if="awaiting"
      class="flex items-center justify-end gap-2 border-t border-slate-800 px-5 py-3"
    >
      <UButton
        color="neutral"
        variant="ghost"
        :disabled="!canResolve || !access.canExecuteRuns.value"
        :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
        data-testid="pr-review-finish"
        @click="onResolve('finish')"
      >
        {{ t('prReview.finish') }}
      </UButton>
      <UButton
        color="neutral"
        variant="soft"
        :disabled="!canResolve || !hasSelection || !access.canExecuteRuns.value"
        :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
        data-testid="pr-review-post"
        @click="onResolve('post')"
      >
        {{ postReport ? t('prReview.postReport.retry') : t('prReview.post') }}
      </UButton>
      <UButton
        color="primary"
        :loading="prReview.resolving"
        :disabled="!canResolve || !hasSelection || !access.canExecuteRuns.value"
        :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
        data-testid="pr-review-fix"
        @click="onResolve('fix')"
      >
        {{ t('prReview.fix') }}
      </UButton>
    </footer>
  </ResultWindowShell>
</template>
