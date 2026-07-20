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
    selected.value = new Set(findings.value.map((f) => f.id))
  },
  { immediate: true },
)

function toggle(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
function selectAll(): void {
  selected.value = new Set(findings.value.map((f) => f.id))
}
function clearAll(): void {
  selected.value = new Set()
}

const canResolve = computed(() => awaiting.value && !prReview.resolving)
// Fix / Post act on the selection, so they need at least one selected finding; Finish always
// works (it just records the — possibly empty — curated selection and completes the review).
const hasSelection = computed(() => selected.value.size > 0)

async function onResolve(action: PrReviewResolution): Promise<void> {
  const id = instanceId.value
  if (!id || !canResolve.value) return
  if ((action === 'fix' || action === 'post') && !hasSelection.value) return
  await prReview.resolve(id, [...selected.value], action).catch(() => {})
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
          <!-- Selection toolbar -->
          <div v-if="awaiting" class="mb-2 flex items-center gap-3 text-[11px] text-slate-400">
            <span data-testid="pr-review-selected-count">
              {{ t('prReview.selectedCount', { count: selected.size }) }}
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
              :class="
                awaiting && selected.has(f.id)
                  ? 'border-indigo-500/60 bg-indigo-500/5'
                  : 'border-slate-800 bg-slate-900/60'
              "
            >
              <div class="flex items-start gap-2">
                <input
                  v-if="awaiting"
                  type="checkbox"
                  class="mt-1 accent-indigo-500"
                  data-testid="pr-review-finding-toggle"
                  :checked="selected.has(f.id)"
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
                    <h4 class="min-w-0 flex-1 text-[13px] font-medium text-slate-100">
                      {{ f.title }}
                    </h4>
                  </div>
                  <p class="mt-0.5 text-[11px] text-slate-500">
                    {{ f.path
                    }}<template v-if="f.line != null">
                      · {{ t('prReview.line', { line: f.line }) }}</template
                    >
                  </p>
                  <p class="mt-1 whitespace-pre-wrap text-[12px] text-slate-300">
                    {{ f.detail }}
                  </p>
                  <p
                    v-if="f.suggestedFix"
                    class="mt-1 whitespace-pre-wrap rounded-md bg-slate-800/50 px-2 py-1 text-[11px] text-slate-300"
                  >
                    <span class="text-slate-500">{{ t('prReview.suggestedFix') }}</span>
                    {{ f.suggestedFix }}
                  </p>
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
