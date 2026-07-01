<script setup lang="ts">
// Human-testing gate window — the dedicated surface for a `human-test` step (opened via the
// universal result-view host, the same seam the tester / requirements review use). It reads
// the gate's live state straight off the execution step (`step.humanTest`, pushed over the
// stream), surfaces the ephemeral environment URL, and drives the human actions: confirm
// (pass + tear down + advance), request a fix from findings (the Tester's fixer), pull latest
// main into the branch + redeploy (conflict → conflict-resolver), recreate, or destroy the env.
import type {
  HumanTestEnvironmentStatus,
  HumanTestRound,
  HumanTestStepState,
} from '~/types/execution'

// The round outcome union (contracts state it inline, so derive it off the round type).
type HumanTestRoundOutcome = NonNullable<HumanTestRound['outcome']>
import StepRunMeta from '~/components/panels/StepRunMeta.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const humanTest = useHumanTestStore()
const { t, d } = useI18n()
const { confirmAction, toastDone } = useConfirmAction()

// Shared seam contract (open/blockId/close + Escape). No `onOpen` loader: the gate state
// rides on the execution step, pushed over the stream.
const { open, blockId, instanceId, stepIndex, close } = useResultView('human-test')
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))

const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const ht = computed<HumanTestStepState | null>(() => step.value?.humanTest ?? null)
const env = computed(() => ht.value?.environment ?? null)
const phase = computed(() => ht.value?.phase ?? null)
const busy = computed(() => (blockId.value ? humanTest.isBusy(blockId.value) : false))

/** Whether the human can act right now (parked awaiting their input, not mid-helper/provision). */
const awaitingHuman = computed(() => phase.value === 'awaiting_human')
const working = computed(
  () =>
    phase.value === 'provisioning' ||
    phase.value === 'fixing' ||
    phase.value === 'resolving_conflicts',
)

// Exhaustive enum→label maps of literal keys (keeps the typed-key drift guard live vs a
// runtime-built `humanTest.envStatus.${status}`). The colour stays a component constant.
const ENV_STATUS_LABEL: Record<HumanTestEnvironmentStatus, string> = {
  provisioning: 'humanTest.envStatus.provisioning',
  ready: 'humanTest.envStatus.ready',
  failed: 'humanTest.envStatus.failed',
  expired: 'humanTest.envStatus.expired',
  tearing_down: 'humanTest.envStatus.tearingDown',
  torn_down: 'humanTest.envStatus.tornDown',
}
const ENV_STATUS_COLOR: Record<HumanTestEnvironmentStatus, string> = {
  provisioning: 'text-amber-300',
  ready: 'text-emerald-300',
  failed: 'text-rose-300',
  expired: 'text-slate-400',
  tearing_down: 'text-slate-400',
  torn_down: 'text-slate-400',
}

const PHASE_LABEL: Record<NonNullable<HumanTestStepState['phase']>, string> = {
  provisioning: 'humanTest.phase.provisioning',
  awaiting_human: 'humanTest.phase.awaitingHuman',
  fixing: 'humanTest.phase.fixing',
  resolving_conflicts: 'humanTest.phase.resolvingConflicts',
  passed: 'humanTest.phase.passed',
}

const ROUND_OUTCOME_LABEL: Record<HumanTestRoundOutcome, string> = {
  completed: 'humanTest.roundOutcome.completed',
  failed: 'humanTest.roundOutcome.failed',
}

const findings = ref('')
const showFindings = ref(false)

async function confirm() {
  if (!blockId.value) return
  await humanTest.confirm(blockId.value)
  close()
}
async function submitFix() {
  if (!blockId.value || !findings.value.trim()) return
  await humanTest.requestFix(blockId.value, findings.value.trim())
  findings.value = ''
  showFindings.value = false
}
async function pullMain() {
  if (!blockId.value) return
  await humanTest.pullMain(blockId.value)
}
async function recreate() {
  if (!blockId.value) return
  await humanTest.recreateEnv(blockId.value)
}
async function destroy() {
  if (!blockId.value) return
  const noun = t('humanTest.envNoun')
  if (!(await confirmAction('destroy', noun))) return
  await humanTest.destroyEnv(blockId.value)
  toastDone('destroy', noun)
}

/** Env actions need a provider (an env is/was present, or it's provisioning) — disabled in degraded mode. */
const envActionsEnabled = computed(() => env.value !== null && env.value !== undefined)

// The env-management actions are only valid in specific phases; mirror the backend's preconditions
// so the UI never dispatches an action that would 409 ("No human-test gate is currently awaiting
// input"). Recreate / pull-main route through `findParked` (parked awaiting the human); destroy
// routes through `findActive`, which also tolerates an in-flight `provisioning` env so a human can
// cancel a slow/stuck provision.
const canManageEnv = computed(() => awaitingHuman.value)
const canDestroy = computed(
  () => envActionsEnabled.value && (awaitingHuman.value || phase.value === 'provisioning'),
)
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
      >
        <!-- Header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300"
          >
            <UIcon name="i-lucide-user-check" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              {{
                block ? t('humanTest.titleWithBlock', { title: block.title }) : t('humanTest.title')
              }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">
              {{ phase ? t(PHASE_LABEL[phase]) : t('humanTest.subtitle') }}
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
            v-if="!ht"
            class="flex flex-col items-center justify-center gap-2 py-10 text-center text-slate-400"
          >
            <UIcon name="i-lucide-user-check" class="h-8 w-8 opacity-40" />
            <p class="text-sm">{{ t('humanTest.notStarted') }}</p>
          </div>

          <template v-else>
            <!-- Environment -->
            <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
              <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('humanTest.environment.heading') }}
              </h3>
              <div v-if="env" class="space-y-2">
                <div class="flex items-center gap-2 text-[13px]">
                  <UIcon
                    name="i-lucide-circle-dot"
                    class="h-3.5 w-3.5"
                    :class="ENV_STATUS_COLOR[env.status]"
                  />
                  <span :class="ENV_STATUS_COLOR[env.status]">{{
                    t(ENV_STATUS_LABEL[env.status])
                  }}</span>
                </div>
                <a
                  v-if="env.url"
                  :href="env.url"
                  target="_blank"
                  rel="noopener"
                  class="inline-flex items-center gap-1.5 break-all text-[13px] text-sky-300 hover:underline"
                >
                  <UIcon name="i-lucide-external-link" class="h-3.5 w-3.5 shrink-0" />
                  {{ env.url }}
                </a>
                <p v-else class="text-[12px] italic text-slate-500">
                  {{ t('humanTest.environment.noUrl') }}
                </p>
                <p v-if="env.expiresAt" class="text-[11px] text-slate-500">
                  {{
                    t('humanTest.environment.expires', { date: d(new Date(env.expiresAt), 'long') })
                  }}
                </p>
              </div>
              <p v-else class="text-[12px] text-amber-300/90">
                {{ ht.degradedReason ?? t('humanTest.environment.none') }}
              </p>
              <p v-if="env && ht.degradedReason" class="mt-2 text-[12px] text-amber-300/90">
                {{ ht.degradedReason }}
              </p>

              <!-- Env management -->
              <div class="mt-3 flex flex-wrap gap-2">
                <UButton
                  size="xs"
                  variant="soft"
                  color="neutral"
                  icon="i-lucide-refresh-cw"
                  :loading="busy"
                  :disabled="busy || !canManageEnv"
                  @click="recreate"
                >
                  {{ t('humanTest.actions.recreate') }}
                </UButton>
                <UButton
                  size="xs"
                  variant="soft"
                  color="neutral"
                  icon="i-lucide-trash-2"
                  :disabled="busy || !canDestroy"
                  @click="destroy"
                >
                  {{ t('humanTest.actions.destroy') }}
                </UButton>
                <UButton
                  size="xs"
                  variant="soft"
                  color="neutral"
                  icon="i-lucide-git-merge"
                  :loading="busy"
                  :disabled="busy || !canManageEnv"
                  @click="pullMain"
                >
                  {{ t('humanTest.actions.pullMain') }}
                </UButton>
              </div>
            </section>

            <!-- Working state -->
            <p
              v-if="working"
              class="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-[12px] text-slate-300"
            >
              <UIcon name="i-lucide-loader" class="h-3.5 w-3.5 animate-spin text-amber-300" />
              {{ phase ? t(PHASE_LABEL[phase]) : '' }}
            </p>

            <!-- Findings / fix -->
            <section
              v-if="awaitingHuman"
              class="rounded-lg border border-slate-800 bg-slate-900/60 p-4"
            >
              <div class="flex items-center justify-between">
                <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('humanTest.fix.heading') }}
                </h3>
                <button
                  class="text-[12px] text-slate-400 hover:text-slate-200"
                  @click="showFindings = !showFindings"
                >
                  {{ showFindings ? t('humanTest.fix.cancel') : t('humanTest.fix.requestFix') }}
                </button>
              </div>
              <div v-if="showFindings" class="mt-2 space-y-2">
                <textarea
                  v-model="findings"
                  rows="4"
                  :placeholder="t('humanTest.fix.placeholder')"
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
                  {{ t('humanTest.fix.send') }}
                </UButton>
              </div>
            </section>

            <!-- Rounds history -->
            <section
              v-if="ht.rounds && ht.rounds.length"
              class="rounded-lg border border-slate-800 bg-slate-900/60 p-4"
            >
              <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('humanTest.history.heading', { count: ht.attempts }, ht.attempts) }}
              </h3>
              <ol class="space-y-2">
                <li v-for="(r, i) in ht.rounds" :key="i" class="flex items-start gap-2 text-[12px]">
                  <UIcon
                    :name="r.kind === 'fix' ? 'i-lucide-wrench' : 'i-lucide-git-merge'"
                    class="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400"
                  />
                  <div class="min-w-0 flex-1">
                    <span class="text-slate-200">{{
                      r.kind === 'fix'
                        ? t('humanTest.history.fixRequested')
                        : t('humanTest.history.pulledMain')
                    }}</span>
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
                        r.outcome
                          ? t(ROUND_OUTCOME_LABEL[r.outcome])
                          : t('humanTest.roundOutcome.inProgress')
                      }}
                    </span>
                    <p v-if="r.findings" class="leading-snug text-slate-400">{{ r.findings }}</p>
                  </div>
                </li>
              </ol>
            </section>
          </template>
        </div>

        <!-- Footer: the primary confirm action -->
        <footer
          v-if="ht"
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
          <UButton
            color="primary"
            icon="i-lucide-circle-check"
            :loading="busy"
            :disabled="busy || !awaitingHuman"
            @click="confirm"
          >
            {{ t('humanTest.confirm') }}
          </UButton>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
