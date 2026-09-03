<script setup lang="ts">
// Bug-fishing expedition window — the dedicated surface for the read-only `bug-fisher`'s
// multi-angle catch, opened via the universal result-view host. It reads the live expedition
// state straight off the run's `bug-fisher` step (`step.bugFishing`, kept fresh by the
// execution stream) and lets a human triage what each angle caught.
//
// The one thing that makes this window different from the PR-review window it is otherwise
// modelled on: triage is available WHILE the expedition is still fishing. Each angle is its own
// container dispatch, so a completed phase's findings are final the moment they land, and
// marking one spawns its bug-fix task immediately rather than at the end. The phase rail on the
// left is what makes that legible: it shows which angles have landed, which is being fished now,
// and which are still queued.
//
// Marking is per-finding rather than a multi-select-then-resolve, because each mark is a
// side effect (a task is created and its run started) rather than a selection to be applied
// later. The pipeline override applies to the marks made after it is changed, and the window
// says which pipeline it will use before anything is created.
import { computed, ref } from 'vue'
import { useResultView } from '~/composables/useResultView'
import { useExecutionStore } from '~/stores/execution'
import { useBoardStore } from '~/stores/board'
import { usePipelinesStore } from '~/stores/pipelines'
import { useUiStore } from '~/stores/ui'
import { pipelineAllowedForTaskType } from '~/utils/pipeline'
import { useBugFishingStore } from '~/stores/bugFishing'
import { bugFishingSpawnIsClaimable } from '@cat-factory/contracts'
import type { BugFishingFinding, BugFishingSeverity, BugFishingStepState } from '~/types/execution'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'
import MarkdownProse from '~/components/common/MarkdownProse.vue'

const execution = useExecutionStore()
const board = useBoardStore()
const pipelines = usePipelinesStore()
const bugFishing = useBugFishingStore()
const ui = useUiStore()
const access = useWorkspaceAccess()

const { t } = useI18n()

const { open, blockId, instanceId, stepIndex, close } = useResultView('bug-fishing', {
  onOpen: ({ instanceId }) => {
    if (instanceId) void bugFishing.load(instanceId)
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
const state = computed<BugFishingStepState | null>(() => step.value?.bugFishing ?? null)
const status = computed(() => state.value?.status ?? null)
const awaiting = computed(() => status.value === 'awaiting_triage')
const fishing = computed(() => status.value === 'fishing')

const phases = computed(() => state.value?.phases ?? [])
const findings = computed(() => state.value?.findings ?? [])

/** Severity order, most severe first — the one place the window's ranking is stated. */
const SEVERITY_ORDER: BugFishingSeverity[] = ['critical', 'high', 'medium', 'low']
const severityRank = (s: BugFishingSeverity) => {
  const i = SEVERITY_ORDER.indexOf(s)
  return i === -1 ? SEVERITY_ORDER.length : i
}

/**
 * Which phase's findings the reader is looking at. `null` is "everything caught so far", which
 * is the default because an expedition's value is the whole catch — the per-phase filter exists
 * for someone working through one angle at a time, not as the primary reading.
 */
const selectedPhaseId = ref<string | null>(null)

/** Whether findings whose decision has been made are shown. Off by default: what is left to
 *  decide is the working list, and a triaged finding that stays in it reads as untriaged. */
const showTriaged = ref(false)

/**
 * Whether a finding is still OPEN — nothing is being done about it, so it belongs in the working
 * list and the Fix button applies to it.
 *
 * Never `!f.spawn`: a spawn record whose status is `failed` is a mark the platform did not carry
 * out, and reading the record's mere PRESENCE as "being fixed" is how a finding nobody is working
 * on would drop out of the list of things left to decide. The rule is the engine's own
 * (`@cat-factory/contracts`), so this window cannot come to offer a mark the engine refuses.
 */
function isOpen(f: BugFishingFinding): boolean {
  return !f.dismissed && bugFishingSpawnIsClaimable(f.spawn, Date.now())
}

const visibleFindings = computed<BugFishingFinding[]>(() => {
  const byPhase = selectedPhaseId.value
    ? findings.value.filter((f) => f.phaseId === selectedPhaseId.value)
    : findings.value
  const triaged = showTriaged.value ? byPhase : byPhase.filter(isOpen)
  return [...triaged].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
})

/** Findings with no decision yet, across every phase — what the header counts. */
const untriagedCount = computed(() => findings.value.filter(isOpen).length)
/** Findings whose fix task EXISTS. A claim still in flight is not one, and a failed one is not. */
const spawnedCount = computed(
  () => findings.value.filter((f) => f.spawn?.status === 'spawned').length,
)

/** The phase the rail has selected, when one is. */
const selectedPhase = computed(() =>
  selectedPhaseId.value ? (phases.value.find((p) => p.id === selectedPhaseId.value) ?? null) : null,
)

/** How many angles have settled (completed or failed) — what the still-fishing banner counts. */
const settledPhaseCount = computed(
  () => phases.value.filter((p) => p.status === 'completed' || p.status === 'failed').length,
)

/** How many findings each phase contributed, for the rail's per-angle count. */
function phaseFindingCount(phaseId: string): number {
  return findings.value.filter((f) => f.phaseId === phaseId).length
}

/**
 * The pipeline spawned fix tasks will run: the board's configured default, overridden here for
 * the marks made while the override is set. Stated in the window BEFORE anything is created,
 * because the pipeline is the whole shape of the work a mark causes.
 */
/** '' means "use the board's default", the same spelling the workspace settings field uses. */
const pipelineOverride = ref('')
const defaultPipelineId = computed(() => state.value?.defaultFixPipelineId ?? null)
/** What a mark made right now would run on — the override if one is set, else the board default. */
const effectivePipelineName = computed(() => {
  const id = pipelineOverride.value || defaultPipelineId.value
  if (!id) return null
  return pipelines.getPipeline(id)?.name ?? id
})
/**
 * The pipelines a spawned fix task may run: the ones this board offers a `bug` task, since that is
 * exactly what a spawned fix IS. Narrowed by the same predicate the create form uses, so the two
 * screens cannot disagree about what a bug task may run. The leading row carries '' so "the
 * board's default" is a value someone can pick back to rather than only a starting state.
 */
const pipelineOptions = computed(() => [
  { value: '', label: t('bugFishing.fixPipeline.boardDefault') },
  ...pipelines.pipelines
    .filter((p) => pipelineAllowedForTaskType(p, 'bug'))
    .map((p) => ({ label: p.name, value: p.id })),
])

/** Marking a finding STARTS a run, so it takes the run-execution permission, not board write. */
const canAct = computed(() => access.canExecuteRuns.value)

async function mark(finding: BugFishingFinding): Promise<void> {
  if (!instanceId.value) return
  await bugFishing.address(instanceId.value, [finding.id], pipelineOverride.value || undefined)
}

async function dismiss(finding: BugFishingFinding): Promise<void> {
  if (!instanceId.value) return
  await bugFishing.dismiss(instanceId.value, finding.id)
}

async function finish(): Promise<void> {
  if (!instanceId.value) return
  await bugFishing.resolve(instanceId.value)
  close()
}

/** Open the task a marked finding spawned, so the reader can follow the work they caused. */
function openSpawnedTask(taskId: string): void {
  close()
  ui.select(taskId)
  ui.focus(taskId)
}

const SEVERITY_CLASS: Record<BugFishingSeverity, string> = {
  critical: 'bg-red-500/15 text-red-300 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  medium: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
  low: 'bg-slate-500/15 text-slate-300 border-slate-600/40',
}

const PHASE_ICON: Record<string, string> = {
  pending: 'i-lucide-circle-dashed',
  fishing: 'i-lucide-loader-circle',
  completed: 'i-lucide-check',
  failed: 'i-lucide-triangle-alert',
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-fish"
    icon-class="bg-sky-500/15 text-sky-300"
    :title="block ? t('bugFishing.titleWithBlock', { title: block.title }) : t('bugFishing.title')"
    :subtitle="t('bugFishing.subtitle')"
    width="full"
    testid="bug-fishing-window"
    :step="{ instanceId, stepIndex }"
    @close="close"
  >
    <div class="flex min-h-0 flex-1">
      <!-- The phase rail: which angles have landed, which is being fished, which are queued.
           It is what makes mid-expedition triage legible — a reader has to be able to tell a
           phase that found nothing from one that has not run yet. -->
      <aside
        data-testid="bug-fishing-phases"
        class="w-60 shrink-0 overflow-y-auto border-r border-slate-800 px-3 py-4"
      >
        <p class="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {{ t('bugFishing.phases.heading') }}
        </p>
        <button
          type="button"
          class="mb-1 w-full rounded-md px-2 py-1.5 text-left text-[12px]"
          :class="
            selectedPhaseId === null
              ? 'bg-slate-800 text-slate-100'
              : 'text-slate-400 hover:bg-slate-800/60'
          "
          @click="selectedPhaseId = null"
        >
          {{ t('bugFishing.phases.all', { count: findings.length }) }}
        </button>
        <ul class="space-y-0.5">
          <li v-for="phase in phases" :key="phase.id">
            <button
              type="button"
              class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left"
              :class="
                selectedPhaseId === phase.id
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-800/60'
              "
              :data-testid="`bug-fishing-phase-${phase.id}`"
              @click="selectedPhaseId = phase.id"
            >
              <UIcon
                :name="PHASE_ICON[phase.status] ?? 'i-lucide-circle-dashed'"
                class="mt-0.5 h-3.5 w-3.5 shrink-0"
                :class="{
                  'animate-spin text-sky-300': phase.status === 'fishing',
                  'text-emerald-400': phase.status === 'completed',
                  'text-amber-400': phase.status === 'failed',
                  'text-slate-600': phase.status === 'pending',
                }"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[12px]">{{ phase.title }}</span>
                <span class="block text-[10px] text-slate-500">
                  {{
                    phase.status === 'completed' || phase.status === 'failed'
                      ? t('bugFishing.phases.found', { count: phaseFindingCount(phase.id) })
                      : t(`bugFishing.phases.status.${phase.status}`)
                  }}
                </span>
              </span>
            </button>
          </li>
        </ul>
      </aside>

      <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <!-- The selected phase's own account of what it covered. Rendered for a FAILED phase
             too, carrying its reason: a phase that reported nothing because it crashed and one
             that reported nothing because it found nothing are different facts. -->
        <div
          v-if="selectedPhase"
          class="mb-4 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5"
        >
          <p class="text-[11px] text-slate-400">{{ selectedPhase.goal }}</p>
          <p
            v-if="selectedPhase.status === 'failed'"
            data-testid="bug-fishing-phase-failed"
            class="mt-2 text-[12px] text-amber-300"
          >
            {{ t('bugFishing.phases.failedNote', { reason: selectedPhase.failureReason ?? '' }) }}
          </p>
          <MarkdownProse
            v-else-if="selectedPhase.summary"
            :text="selectedPhase.summary"
            class="mt-2 max-w-3xl text-[12px]"
          />
        </div>

        <!-- The still-fishing banner. Deliberately shown ABOVE the findings rather than in place
             of them: everything already caught is actionable now, which is the whole design. -->
        <div
          v-if="fishing"
          data-testid="bug-fishing-in-progress"
          class="mb-4 flex items-center gap-2 rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-[12px] text-sky-200"
        >
          <UIcon name="i-lucide-loader-circle" class="h-4 w-4 shrink-0 animate-spin" />
          <span>
            {{
              t('bugFishing.stillFishing', {
                done: settledPhaseCount,
                total: phases.length,
              })
            }}
          </span>
        </div>

        <!-- What the marks will run. Stated before anything is created, because the pipeline is
             the shape of the work a mark causes. -->
        <div
          v-if="canAct"
          data-testid="bug-fishing-pipeline"
          class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2"
        >
          <span class="text-[11px] text-slate-400">{{ t('bugFishing.fixPipeline.label') }}</span>
          <USelectMenu
            v-model="pipelineOverride"
            :items="pipelineOptions"
            value-key="value"
            size="xs"
            class="min-w-52"
          />
          <span class="text-[11px] text-slate-500">
            {{ t('bugFishing.fixPipeline.hint', { pipeline: effectivePipelineName ?? '—' }) }}
          </span>
        </div>

        <div class="mb-2 flex items-center justify-between">
          <p class="text-[11px] text-slate-400">
            {{ t('bugFishing.counts', { untriaged: untriagedCount, spawned: spawnedCount }) }}
          </p>
          <label class="flex items-center gap-1.5 text-[11px] text-slate-400">
            <input v-model="showTriaged" type="checkbox" class="accent-sky-500" />
            {{ t('bugFishing.showTriaged') }}
          </label>
        </div>

        <p v-if="bugFishing.error" class="mb-3 text-[12px] text-red-300">
          {{ bugFishing.error }}
        </p>

        <!-- An expedition that caught nothing is a real answer, not an empty state. The copy
             says which of the two it is, because "nothing found" and "nothing left to triage"
             are different things to be told. -->
        <div
          v-if="visibleFindings.length === 0"
          data-testid="bug-fishing-empty"
          class="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-8 text-center text-[12px] text-slate-400"
        >
          {{
            findings.length === 0
              ? t('bugFishing.empty.nothingCaught')
              : t('bugFishing.empty.allTriaged')
          }}
        </div>

        <ul v-else class="space-y-2">
          <li
            v-for="finding in visibleFindings"
            :key="finding.id"
            :data-testid="`bug-fishing-finding-${finding.id}`"
            class="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5"
            :class="{ 'opacity-60': finding.dismissed }"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                :class="SEVERITY_CLASS[finding.severity]"
              >
                {{ t(`bugFishing.severity.${finding.severity}`) }}
              </span>
              <span class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                {{ t(`bugFishing.kind.${finding.kind}`) }}
              </span>
              <span class="text-[10px] text-slate-500">
                {{ t(`bugFishing.confidence.${finding.confidence}`) }}
              </span>
              <span
                class="min-w-0 flex-1 text-[13px] text-slate-100"
                :class="{ 'line-through': finding.dismissed }"
              >
                {{ finding.title }}
              </span>
            </div>

            <p v-if="finding.path" class="mt-1 font-mono text-[11px] text-slate-500">
              {{ finding.path }}<span v-if="finding.line">:{{ finding.line }}</span>
            </p>

            <MarkdownProse :text="finding.detail" class="mt-2 max-w-3xl text-[12px]" />

            <div v-if="finding.failureScenario" class="mt-2 text-[12px] text-slate-300">
              <span class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('bugFishing.finding.failureScenario') }}
              </span>
              <MarkdownProse :text="finding.failureScenario" class="mt-0.5 max-w-3xl" />
            </div>

            <!-- Evidence is rendered apart from the detail for the reason the contract keeps them
                 apart: a finding that cannot point at the code it describes is speculating, and
                 that should be visible without reading the prose for it. -->
            <details v-if="finding.evidence" class="mt-2">
              <summary class="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">
                {{ t('bugFishing.finding.evidence') }}
              </summary>
              <MarkdownProse :text="finding.evidence" class="mt-1 max-w-3xl text-[12px]" />
            </details>

            <details v-if="finding.suggestedFix" class="mt-1">
              <summary class="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">
                {{ t('bugFishing.finding.suggestedFix') }}
              </summary>
              <MarkdownProse :text="finding.suggestedFix" class="mt-1 max-w-3xl text-[12px]" />
            </details>

            <!-- Already marked: say what was created and let the reader follow it. The three
                 spawn states are rendered apart because they are three different facts — a task
                 that exists, one being made, and a mark that did not land — and only the last
                 one is something the reader has to do again. -->
            <div
              v-if="finding.spawn?.status === 'spawned'"
              data-testid="bug-fishing-finding-spawned"
              class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-emerald-300"
            >
              <UIcon name="i-lucide-check-circle-2" class="h-3.5 w-3.5" />
              <span>
                {{
                  t('bugFishing.finding.spawned', {
                    pipeline:
                      pipelines.getPipeline(finding.spawn.pipelineId)?.name ??
                      finding.spawn.pipelineId,
                  })
                }}
              </span>
              <button
                type="button"
                class="underline hover:text-emerald-200"
                @click="openSpawnedTask(finding.spawn.taskId)"
              >
                {{ t('bugFishing.finding.openTask') }}
              </button>
            </div>

            <!-- A claim held by a marking still in flight. No task to link yet, and no Fix
                 button: pressing it again is exactly the double-spawn the claim prevents. -->
            <div
              v-else-if="finding.spawn?.status === 'pending'"
              data-testid="bug-fishing-finding-spawning"
              class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400"
            >
              <UIcon name="i-lucide-loader-circle" class="h-3.5 w-3.5 animate-spin" />
              <span>{{ t('bugFishing.finding.spawning') }}</span>
            </div>

            <!-- A mark that did not land. Says so and carries the cause, because the finding is
                 markable again and the reader is the one who has to decide to try. -->
            <p
              v-else-if="finding.spawn?.status === 'failed'"
              data-testid="bug-fishing-finding-spawn-failed"
              class="mt-2 max-w-3xl text-[11px] text-amber-300"
            >
              {{
                t('bugFishing.finding.spawnFailed', {
                  reason: finding.spawn.failureReason ?? '',
                })
              }}
            </p>

            <div v-if="isOpen(finding) && canAct" class="mt-2 flex items-center gap-2">
              <UButton
                size="xs"
                color="primary"
                icon="i-lucide-wrench"
                :loading="bugFishing.spawning.has(finding.id)"
                :disabled="finding.dismissed || bugFishing.spawning.has(finding.id)"
                :data-testid="`bug-fishing-fix-${finding.id}`"
                @click="mark(finding)"
              >
                {{ t('bugFishing.finding.fixThis') }}
              </UButton>
              <UButton
                v-if="!finding.dismissed"
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="bugFishing.spawning.has(finding.id)"
                @click="dismiss(finding)"
              >
                {{ t('bugFishing.finding.dismiss') }}
              </UButton>
            </div>
          </li>
        </ul>

        <StepRunMeta v-if="step" :step="step" class="mt-5" />
      </div>
    </div>

    <!-- Footer. Rendered only once every angle has settled: while the expedition is still
         fishing there is nothing to finish, and offering it would read as a way to stop the hunt
         (it is not — the run advances past the step and the remaining angles never run). -->
    <footer
      v-if="awaiting"
      class="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3"
    >
      <p class="text-[11px] text-slate-500">
        {{
          untriagedCount > 0
            ? t('bugFishing.footer.parkedWithUntriaged', { count: untriagedCount })
            : t('bugFishing.footer.parked')
        }}
      </p>
      <UButton
        color="primary"
        icon="i-lucide-check"
        :loading="bugFishing.resolving"
        :disabled="!canAct"
        :title="canAct ? undefined : t('access.noRunExecute')"
        data-testid="bug-fishing-finish"
        @click="finish"
      >
        {{ t('bugFishing.footer.finish') }}
      </UButton>
    </footer>
  </ResultWindowShell>
</template>
