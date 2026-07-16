<script setup lang="ts">
// Ralph loop window — the dedicated surface for a `ralph` step, opened via the universal
// result-view host. It surfaces the persistent retry-until-done loop the backend persists on
// `step.ralph`: the programmatic completion command, the iteration count vs the budget, the
// most recent validation exit code + output, and the per-iteration history. Synchronous — it
// reads straight off the execution step (no fetch on open).
import { computed } from 'vue'
import { agentKindMeta } from '~/utils/catalog'
import type { RalphStepState } from '~/types/execution'
import StepRestartControl from '~/components/panels/StepRestartControl.vue'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'
import CopyButton from '~/components/common/CopyButton.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const { t, d } = useI18n()

const { open, blockId, instanceId, stepIndex, close } = useResultView('ralph-loop')
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const prUrl = computed(() => block.value?.pullRequest?.url ?? null)

const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const ralph = computed<RalphStepState | null>(() => step.value?.ralph ?? null)
const meta = computed(() => agentKindMeta('ralph'))

// Iterations, newest-first for the timeline.
const attempts = computed(() => [...(ralph.value?.attemptLog ?? [])].reverse())

/**
 * The display status, rolled up from the persisted loop state + the run status:
 *  - `passed`  — the step finished (the validation command exited 0);
 *  - `gave-up` — the run failed here (the iteration budget was spent);
 *  - `running` — an iteration is in flight;
 *  - `failing` — the last validation failed and another iteration is about to run.
 */
type RalphDisplayStatus = 'passed' | 'gave-up' | 'running' | 'failing'
const status = computed<RalphDisplayStatus>(() => {
  const s = step.value
  if (!s) return 'running'
  if (s.state === 'done') return 'passed'
  if (instance.value?.status === 'failed') return 'gave-up'
  if (s.container?.status === 'starting' || s.container?.status === 'up') return 'running'
  return 'failing'
})

const STATUS_META = computed<
  Record<
    RalphDisplayStatus,
    {
      label: string
      badge: 'success' | 'warning' | 'error' | 'neutral'
      icon: string
      text: string
    }
  >
>(() => ({
  passed: {
    label: t('ralph.status.passed'),
    badge: 'success',
    icon: 'i-lucide-circle-check',
    text: 'text-emerald-300',
  },
  'gave-up': {
    label: t('ralph.status.gaveUp'),
    badge: 'error',
    icon: 'i-lucide-circle-x',
    text: 'text-rose-300',
  },
  running: {
    label: t('ralph.status.running'),
    badge: 'warning',
    icon: 'i-lucide-loader',
    text: 'text-amber-300',
  },
  failing: {
    label: t('ralph.status.failing'),
    badge: 'error',
    icon: 'i-lucide-circle-x',
    text: 'text-rose-300',
  },
}))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex max-h-[100dvh] items-stretch justify-center bg-slate-950/70 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="m-4 flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
        role="dialog"
        aria-modal="true"
        data-testid="ralph-loop-window"
      >
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300"
          >
            <UIcon :name="meta.icon" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              {{ meta.label }}{{ block ? ` — ${block.title}` : '' }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">{{ t('ralph.subtitle') }}</p>
          </div>
          <UBadge
            :color="STATUS_META[status].badge"
            variant="subtle"
            size="sm"
            data-testid="ralph-status"
          >
            {{ STATUS_META[status].label }}
          </UBadge>
          <StepRestartControl
            :instance-id="instanceId"
            :step-index="stepIndex"
            @restarted="close"
          />
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

        <div class="flex min-h-0 flex-1">
          <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            <div
              v-if="!ralph"
              class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
            >
              <UIcon :name="meta.icon" class="h-8 w-8 opacity-40" />
              <p class="text-sm">{{ t('ralph.noActivity') }}</p>
            </div>

            <template v-else>
              <!-- The completion criterion. -->
              <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('ralph.validationCommand') }}
              </h3>
              <div class="relative rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
                <CopyButton :text="ralph.validationCommand" class="absolute end-1 top-1" />
                <code class="block whitespace-pre-wrap pe-8 font-mono text-[12px] text-slate-200">{{
                  ralph.validationCommand
                }}</code>
              </div>

              <!-- The most recent validation output. -->
              <template v-if="ralph.lastValidationTail">
                <h3
                  class="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                >
                  {{ t('ralph.lastOutput', { exit: ralph.lastExitCode ?? '?' }) }}
                </h3>
                <div class="relative rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
                  <CopyButton :text="ralph.lastValidationTail" class="absolute end-1 top-1" />
                  <pre
                    class="whitespace-pre-wrap pe-8 font-mono text-[11px] leading-relaxed text-slate-400"
                    >{{ ralph.lastValidationTail }}</pre
                  >
                </div>
              </template>

              <a
                v-if="prUrl"
                :href="prUrl"
                target="_blank"
                rel="noopener"
                class="mt-3 inline-flex items-center gap-1 text-[12px] text-sky-300 hover:text-sky-200 hover:underline"
              >
                {{ t('ralph.viewPr') }}
                <UIcon name="i-lucide-external-link" class="h-3 w-3" />
              </a>

              <!-- Iteration history: what each pass produced and whether its validation passed. -->
              <section v-if="attempts.length" class="mt-5">
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('ralph.iterationsHeading') }}
                </h3>
                <ol class="space-y-2">
                  <li
                    v-for="a in attempts"
                    :key="a.attempt"
                    class="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2"
                    data-testid="ralph-iteration"
                  >
                    <div class="flex items-center gap-2">
                      <UIcon
                        :name="a.validationPassed ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
                        class="h-3.5 w-3.5"
                        :class="a.validationPassed ? 'text-emerald-400' : 'text-rose-400'"
                      />
                      <span class="text-[12px] font-medium text-slate-200">
                        {{ t('ralph.iteration', { number: a.attempt }) }}
                      </span>
                      <span class="text-[11px] text-slate-500">
                        {{
                          a.validationPassed
                            ? t('ralph.iterationPassed')
                            : t('ralph.iterationFailed', { exit: a.exitCode ?? '?' })
                        }}
                      </span>
                      <span class="ms-auto text-[10px] text-slate-600">{{
                        d(new Date(a.at), 'long')
                      }}</span>
                    </div>
                    <p
                      v-if="a.summary"
                      class="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-400"
                    >
                      {{ a.summary }}
                    </p>
                  </li>
                </ol>
              </section>
            </template>
          </div>

          <aside
            class="hidden w-60 shrink-0 flex-col gap-4 border-s border-slate-800 bg-slate-900/50 px-4 py-4 lg:flex"
          >
            <div v-if="ralph">
              <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('ralph.sidebar.state') }}
              </h4>
              <div class="flex items-center gap-2 text-[13px]">
                <UIcon
                  :name="STATUS_META[status].icon"
                  class="h-4 w-4"
                  :class="STATUS_META[status].text"
                />
                <span :class="STATUS_META[status].text">{{ STATUS_META[status].label }}</span>
              </div>
            </div>
            <div v-if="ralph">
              <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('ralph.sidebar.iterations') }}
              </h4>
              <p class="text-[12px] text-slate-300" data-testid="ralph-iteration-count">
                {{
                  t('ralph.sidebar.count', { attempts: ralph.attempts, max: ralph.maxIterations })
                }}
              </p>
            </div>
            <StepRunMeta
              v-if="step"
              :step="step"
              :instance-id="instanceId ?? undefined"
              :step-number="stepIndex === null ? undefined : stepIndex + 1"
              :total-steps="instance?.steps.length"
              :run-failed="instance?.status === 'failed'"
              :failure-at="instance?.failure?.occurredAt"
            />
            <p class="mt-auto text-[10px] leading-relaxed text-slate-600">
              {{ t('ralph.sidebar.footer') }}
            </p>
          </aside>
        </div>
      </div>
    </div>
  </Teleport>
</template>
