<script setup lang="ts">
// Gate window — the dedicated surface for a polling gate step (`ci` / `conflicts`),
// opened via the universal result-view host (the same seam the test report and the
// requirements review use). It surfaces the gate's conclusion that the backend now
// persists on `step.gate`: the precheck verdict, the helper attempt budget, the gated
// commit, and — for CI — the failing checks behind the failure. One window serves both
// gates; it branches on the step's `agentKind` for the copy and the failure detail.
import { computed } from 'vue'
import { agentKindMeta } from '~/utils/catalog'
import type { GateStepState } from '~/types/execution'

const board = useBoardStore()
const execution = useExecutionStore()

// Synchronous window: it reads its state straight off the execution step, so there's
// nothing to fetch on open (no `onOpen` loader).
const { open, blockId, instanceId, stepIndex, close } = useResultView('gate')
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))

const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const gate = computed<GateStepState | null>(() => step.value?.gate ?? null)

const isCi = computed(() => step.value?.agentKind === 'ci')
const meta = computed(() => agentKindMeta(step.value?.agentKind ?? 'ci'))
const helperKind = computed(() => (isCi.value ? 'ci-fixer' : 'conflict-resolver'))
const helperMeta = computed(() => agentKindMeta(helperKind.value))

const failingChecks = computed(() => gate.value?.failingChecks ?? [])
const shortSha = computed(() => (gate.value?.headSha ? gate.value.headSha.slice(0, 7) : null))

/**
 * The display status — a roll-up of the persisted gate state + the run's status, so the
 * window reads as a conclusion rather than raw fields:
 *  - `passed`   — the step finished (the precheck went green; the helper was never needed
 *                 or fixed it);
 *  - `gave-up`  — the run failed at this gate (attempt budget spent);
 *  - `fixing`   — a helper agent is in flight on a failed precheck;
 *  - `failing`  — the precheck failed and a helper is about to run;
 *  - `pending`  — the provider is still computing;
 *  - `checking` — running the precheck.
 */
type GateDisplayStatus = 'passed' | 'gave-up' | 'fixing' | 'failing' | 'pending' | 'checking'
const status = computed<GateDisplayStatus>(() => {
  const s = step.value
  if (!s) return 'checking'
  if (s.state === 'done') return 'passed'
  if (instance.value?.status === 'failed') return 'gave-up'
  if (gate.value?.phase === 'working') return 'fixing'
  if (gate.value?.lastVerdict === 'fail') return 'failing'
  if (gate.value?.lastVerdict === 'pending') return 'pending'
  return 'checking'
})

const STATUS_META: Record<
  GateDisplayStatus,
  { label: string; badge: 'success' | 'warning' | 'error' | 'neutral'; icon: string; text: string }
> = {
  passed: {
    label: 'Passed',
    badge: 'success',
    icon: 'i-lucide-circle-check',
    text: 'text-emerald-300',
  },
  'gave-up': { label: 'Gave up', badge: 'error', icon: 'i-lucide-circle-x', text: 'text-rose-300' },
  fixing: { label: 'Fixing', badge: 'warning', icon: 'i-lucide-loader', text: 'text-amber-300' },
  failing: {
    label: 'Failing',
    badge: 'error',
    icon: 'i-lucide-circle-x',
    text: 'text-rose-300',
  },
  pending: {
    label: 'Pending',
    badge: 'neutral',
    icon: 'i-lucide-clock',
    text: 'text-slate-300',
  },
  checking: {
    label: 'Checking',
    badge: 'neutral',
    icon: 'i-lucide-loader',
    text: 'text-slate-300',
  },
}

// The conflicts gate has no structured detail (GitHub reports mergeability as a single
// verdict, no file list), so the window shows the verdict + a note rather than a list.
const conflictVerdict = computed(() => {
  if (status.value === 'passed') return 'Mergeable'
  if (gate.value?.lastVerdict === 'pending') return 'Computing mergeability…'
  if (gate.value?.lastVerdict === 'fail') return 'Conflicts with base'
  return 'Unknown'
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-stretch justify-center bg-slate-950/70 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="m-4 flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
      >
        <!-- Header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/15 text-sky-300"
          >
            <UIcon :name="meta.icon" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              {{ meta.label }}{{ block ? ` — ${block.title}` : '' }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">
              {{
                isCi
                  ? 'Gates the PR on green CI, looping the CI fixer on failure'
                  : 'Gates the PR on a clean merge, looping the resolver on conflicts'
              }}
            </p>
          </div>
          <UBadge :color="STATUS_META[status].badge" variant="subtle" size="sm">
            {{ STATUS_META[status].label }}
          </UBadge>
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

        <div class="flex min-h-0 flex-1">
          <!-- Main: the conclusion -->
          <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            <div
              v-if="!gate"
              class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
            >
              <UIcon :name="meta.icon" class="h-8 w-8 opacity-40" />
              <p class="text-sm">No gate activity yet.</p>
              <p class="max-w-sm text-[11px] text-slate-500">
                The precheck runs once the PR is open. While it polls, the step shows live
                state on the board.
              </p>
            </div>

            <template v-else>
              <!-- Passed -->
              <div
                v-if="status === 'passed'"
                class="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5"
              >
                <UIcon name="i-lucide-circle-check" class="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <p class="text-[13px] leading-relaxed text-emerald-200">
                  {{ step?.output || (isCi ? 'CI is green.' : 'The PR merges cleanly with its base.') }}
                </p>
              </div>

              <!-- CI: failing checks -->
              <template v-else-if="isCi">
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Failing checks
                </h3>
                <ul v-if="failingChecks.length" class="space-y-1">
                  <li
                    v-for="(c, i) in failingChecks"
                    :key="`${c.name}-${i}`"
                    class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-1.5"
                  >
                    <UIcon name="i-lucide-circle-x" class="h-3.5 w-3.5 shrink-0 text-rose-400" />
                    <span class="min-w-0 flex-1 truncate text-[13px] text-slate-200">{{ c.name }}</span>
                    <span class="shrink-0 text-[11px] uppercase text-rose-300">
                      {{ c.conclusion ?? 'failure' }}
                    </span>
                  </li>
                </ul>
                <p v-else class="text-[13px] leading-relaxed text-slate-300">
                  {{ gate.lastFailureSummary || 'CI has not reported a failure on this commit.' }}
                </p>
              </template>

              <!-- Conflicts: verdict + note (no file-level detail from GitHub) -->
              <template v-else>
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Mergeability
                </h3>
                <div
                  class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2"
                >
                  <UIcon
                    :name="STATUS_META[status].icon"
                    class="h-4 w-4 shrink-0"
                    :class="STATUS_META[status].text"
                  />
                  <span class="text-[13px] text-slate-200">{{ conflictVerdict }}</span>
                </div>
                <p class="mt-2 text-[11px] leading-relaxed text-slate-500">
                  GitHub reports mergeability as a single verdict, so there's no file-level
                  conflict list here. The conflict resolver inspects the branch directly.
                </p>
              </template>
            </template>
          </div>

          <!-- Sidebar: gate state -->
          <aside
            class="hidden w-56 shrink-0 flex-col gap-4 border-l border-slate-800 bg-slate-900/50 px-4 py-4 lg:flex"
          >
            <div v-if="gate">
              <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                State
              </h4>
              <div class="flex items-center gap-2 text-[13px]">
                <UIcon :name="STATUS_META[status].icon" class="h-4 w-4" :class="STATUS_META[status].text" />
                <span :class="STATUS_META[status].text">{{ STATUS_META[status].label }}</span>
              </div>
            </div>

            <div v-if="gate">
              <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ helperMeta.label }}
              </h4>
              <p class="text-[12px] text-slate-300">
                {{ gate.attempts }}/{{ gate.maxAttempts }} attempt{{ gate.maxAttempts === 1 ? '' : 's' }}
                <template v-if="gate.phase === 'working'"> · running…</template>
                <template v-else-if="gate.attempts === 0"> · not needed yet</template>
              </p>
            </div>

            <div v-if="shortSha">
              <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Gated commit
              </h4>
              <p class="font-mono text-[12px] text-slate-300">{{ shortSha }}</p>
            </div>

            <div v-if="step?.model">
              <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Model
              </h4>
              <p class="break-all text-[12px] text-slate-300">{{ step.model }}</p>
            </div>

            <p class="mt-auto text-[10px] leading-relaxed text-slate-600">
              A gate runs a programmatic precheck and only spins up the
              {{ helperMeta.label }} when it fails — a green check advances with nothing
              spun up.
            </p>
          </aside>
        </div>
      </div>
    </div>
  </Teleport>
</template>
