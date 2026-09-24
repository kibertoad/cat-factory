<script setup lang="ts">
// Judge window — the dedicated surface for a JUDGE step (the fourth step-taxonomy bucket),
// opened via the universal result-view host (the same seam the gate window and the test report
// use). ONE window serves EVERY registered judge: it reads the rubric name, the score, the
// per-task threshold and the findings straight off `step.judge`, so a deployment that registers
// a rubric gets a real result window with no frontend code at all.
//
// When the verdict parked the run it also owns the decision: proceed anyway, bounce the work
// back to the producing step for rework (with optional extra guidance), or stop the run.
import { computed, ref } from 'vue'
import { agentKindMeta } from '~/utils/catalog'
import type { JudgeFinding, JudgeStepState } from '~/types/execution'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import CopyButton from '~/components/common/CopyButton.vue'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import SectionLabel from '~/components/common/SectionLabel.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const judgeStore = useJudgeStore()
const { t, n } = useI18n()
const access = useWorkspaceAccess()

// Synchronous window: it reads its state straight off the execution step, so there is nothing
// to fetch on open. `ResultWindowShell` owns Escape (and focus trap + scroll lock + stacking).
const { open, blockId, instanceId, stepIndex, close } = useResultView('judge')
const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))

const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const judge = computed<JudgeStepState | null>(() => step.value?.judge ?? null)
const meta = computed(() => agentKindMeta(step.value?.agentKind ?? 'judge'))

const rubricName = computed(() => judge.value?.rubricName ?? meta.value.label)
const headerTitle = computed(
  () => `${rubricName.value}${block.value ? ` — ${block.value.title}` : ''}`,
)

const verdict = computed(() => judge.value?.verdict ?? null)
const score = computed(() => verdict.value?.score ?? null)
const threshold = computed(() => judge.value?.threshold ?? null)
const awaiting = computed(() => judge.value?.status === 'awaiting_decision')
const rounds = computed(() => [...(judge.value?.rounds ?? [])].reverse())

// Severity-ordered, worst first — the same order the rework brief hands the producer, so the
// window and the bounced agent agree on what matters.
const SEVERITY_RANK: Record<JudgeFinding['severity'], number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
}
const findings = computed(() =>
  [...(verdict.value?.findings ?? [])].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  ),
)

// Exhaustive maps keyed off the wire unions, so adding a status/severity/disposition upstream
// fails the typecheck here rather than leaking a raw key at runtime (the tier-2 drift guard).
const STATUS_META = computed<
  Record<
    NonNullable<JudgeStepState['status']>,
    { label: string; badge: 'success' | 'warning' | 'error' | 'neutral' }
  >
>(() => ({
  evaluating: { label: t('judge.status.evaluating'), badge: 'neutral' },
  awaiting_decision: { label: t('judge.status.awaitingDecision'), badge: 'warning' },
  bouncing: { label: t('judge.status.bouncing'), badge: 'warning' },
  passed: { label: t('judge.status.passed'), badge: 'success' },
  failed: { label: t('judge.status.failed'), badge: 'error' },
  skipped: { label: t('judge.status.skipped'), badge: 'neutral' },
}))

const SEVERITY_LABELS = computed<Record<JudgeFinding['severity'], string>>(() => ({
  low: t('judge.severity.low'),
  medium: t('judge.severity.medium'),
  high: t('judge.severity.high'),
  critical: t('judge.severity.critical'),
}))

const SEVERITY_CLASSES: Record<JudgeFinding['severity'], string> = {
  low: 'border-muted text-toned',
  medium: 'border-app-warning-500/40 text-app-warning-300',
  high: 'border-app-hue-orange/40 text-app-hue-orange',
  critical: 'border-app-error-500/40 text-app-error-300',
}

const DISPOSITION_LABELS = computed<
  Record<NonNullable<NonNullable<JudgeStepState['disposition']>>, string>
>(() => ({
  pass: t('judge.disposition.pass'),
  park: t('judge.disposition.park'),
  bounce: t('judge.disposition.bounce'),
  fail: t('judge.disposition.fail'),
}))

const feedback = ref('')
const busy = computed(() => judgeStore.resolving)

/**
 * Confirm before discarding typed guidance (UX-79). The feedback box is what a bounced producer is
 * handed as its rework brief, it is held here until one of the three commands is pressed, and this
 * window closes on Escape and on a backdrop click. Flushing it is not an option: every command that
 * would carry it also RESOLVES the parked verdict.
 */
const { requestClose } = useUnsavedGuard({
  open,
  close: () => close(),
  saving: () => busy.value,
  snapshot: () => feedback.value.trim(),
})
const canAct = computed(() => awaiting.value && access.canExecuteRuns.value && !busy.value)

async function act(choice: 'proceed' | 'bounce' | 'stop') {
  const id = instanceId.value
  if (!id) return
  await judgeStore.resolve(id, choice, feedback.value.trim() || undefined)
  feedback.value = ''
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    :icon="meta.icon"
    icon-class="bg-app-warning-500/15 text-app-warning-300"
    :title="headerTitle"
    :subtitle="t('judge.subtitle')"
    :step-ref="{ instanceId, stepIndex }"
    width="3xl"
    @close="requestClose"
  >
    <template #header-extras>
      <UBadge
        v-if="judge"
        :color="STATUS_META[judge.status].badge"
        variant="subtle"
        size="sm"
        data-testid="judge-status"
      >
        {{ STATUS_META[judge.status].label }}
      </UBadge>
    </template>

    <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
      <div
        v-if="!judge"
        class="flex h-full flex-col items-center justify-center gap-2 text-center text-muted"
      >
        <UIcon :name="meta.icon" class="h-8 w-8 opacity-40" />
        <p class="text-sm">{{ t('judge.empty') }}</p>
      </div>

      <template v-else>
        <!-- The score against the task's threshold — the whole verdict in one line. -->
        <div
          class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-default bg-app-950/40 px-3 py-2.5"
          data-testid="judge-score"
        >
          <span class="text-sm font-semibold text-app-100">
            {{ score === null ? t('judge.notScored') : n(score, 'percent') }}
          </span>
          <span
            v-if="threshold !== null"
            class="text-xs text-muted"
            :title="t('judge.thresholdHint')"
          >
            {{ t('judge.threshold', { threshold: n(threshold, 'percent') }) }}
          </span>
          <span v-if="judge.disposition" class="text-xs text-muted">
            · {{ DISPOSITION_LABELS[judge.disposition] }}
          </span>
          <span v-if="judge.rubricOverridden" class="text-2xs text-app-secondary-300">
            · {{ t('judge.rubricOverridden') }}
          </span>
          <span v-if="(judge.maxBounces ?? 0) > 0" class="text-2xs text-dimmed">
            ·
            {{ t('judge.reworkRounds', { spent: judge.bounces ?? 0, budget: judge.maxBounces }) }}
          </span>
        </div>

        <!-- The rubric asked for a model this deployment cannot serve, so something else scored
             the work. Only this case is shown: a pin that was honoured says nothing the model
             name doesn't, and being overridden by the task's own choice is the normal outcome. -->
        <p
          v-if="judge.modelPin?.status === 'unavailable'"
          class="mt-2 rounded-md border border-app-warning-500/30 bg-app-warning-500/5 px-3 py-2 text-xs leading-relaxed text-app-warning-200"
          data-testid="judge-model-pin"
        >
          {{ t('judge.modelPinUnavailable', { model: judge.modelPin.requested }) }}
        </p>

        <!-- Why the judge did nothing, when it did nothing. A skipped judge must never read
             like a clean pass. -->
        <p
          v-if="judge.note"
          class="mt-2 rounded-md border border-default bg-app-950/40 px-3 py-2 text-xs leading-relaxed text-muted"
        >
          {{ judge.note }}
        </p>

        <!-- The verdict a human reads. Markdown, because the judge prompt asks for a verdict
             line plus grouped bullets rather than one paragraph. -->
        <div v-if="verdict?.summary" class="relative mt-3">
          <CopyButton :text="verdict.summary" class="absolute end-1 top-1" />
          <MarkdownProse
            :text="verdict.summary"
            class="pe-8 text-sm leading-relaxed text-default"
          />
        </div>

        <section v-if="findings.length" class="mt-4">
          <SectionLabel as="h3" class="mb-2">
            {{ t('judge.findingsHeading') }}
          </SectionLabel>
          <ul class="flex flex-col gap-2">
            <li
              v-for="(finding, i) in findings"
              :key="`${finding.title}-${i}`"
              class="rounded-md border border-default bg-app-950/40 px-3 py-2"
              data-testid="judge-finding"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class="rounded border px-1.5 py-0.5 text-3xs uppercase tracking-wide"
                  :class="SEVERITY_CLASSES[finding.severity]"
                >
                  {{ SEVERITY_LABELS[finding.severity] }}
                </span>
                <span class="text-sm font-medium text-app-100">{{ finding.title }}</span>
                <code v-if="finding.where" class="text-2xs text-dimmed">{{ finding.where }}</code>
              </div>
              <MarkdownProse
                v-if="finding.detail"
                :text="finding.detail"
                class="mt-1 text-xs leading-relaxed text-muted"
              />
            </li>
          </ul>
        </section>

        <!-- The decision. Only shown while the run is actually parked on this verdict. -->
        <section v-if="awaiting" class="mt-5" data-testid="judge-decision">
          <SectionLabel as="h3" class="mb-1.5">
            {{ t('judge.decisionHeading') }}
          </SectionLabel>
          <p class="mb-2 text-2xs leading-relaxed text-dimmed">
            {{ t('judge.decisionDescription') }}
          </p>
          <textarea
            v-model="feedback"
            rows="3"
            :disabled="busy"
            :placeholder="t('judge.feedbackPlaceholder')"
            class="w-full resize-y rounded-md border border-default bg-app-950/60 px-3 py-2 text-sm text-default placeholder:text-app-600 focus:border-app-warning-500/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-app-warning-500/60"
          />
          <p v-if="judgeStore.error" class="mt-2 text-xs text-app-error-300">
            {{ judgeStore.error }}
          </p>
          <div class="mt-2 flex flex-wrap justify-end gap-2">
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              icon="i-lucide-octagon-x"
              :loading="busy"
              :disabled="!canAct"
              :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
              data-testid="judge-stop"
              @click="act('stop')"
            >
              {{ t('judge.stop') }}
            </UButton>
            <UButton
              size="sm"
              color="warning"
              icon="i-lucide-undo-2"
              :loading="busy"
              :disabled="!canAct"
              :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
              data-testid="judge-bounce"
              @click="act('bounce')"
            >
              {{ t('judge.bounce') }}
            </UButton>
            <UButton
              size="sm"
              color="primary"
              icon="i-lucide-circle-check"
              :loading="busy"
              :disabled="!canAct"
              :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
              data-testid="judge-proceed"
              @click="act('proceed')"
            >
              {{ t('judge.proceed') }}
            </UButton>
          </div>
        </section>

        <!-- The round history: a looping judge must not be a black box (the gate-attempt rule). -->
        <section v-if="rounds.length > 1" class="mt-5">
          <SectionLabel as="h3" class="mb-2">
            {{ t('judge.roundsHeading') }}
          </SectionLabel>
          <ul class="flex flex-col gap-1.5">
            <li
              v-for="round in rounds"
              :key="round.round"
              class="flex flex-wrap items-center gap-2 rounded-md border border-default bg-app-950/40 px-3 py-1.5 text-xs text-toned"
              data-testid="judge-round"
              :data-round-disposition="round.disposition"
            >
              <span class="text-dimmed">{{ t('judge.round', { round: round.round }) }}</span>
              <span class="font-medium text-app-100">{{ n(round.verdict.score, 'percent') }}</span>
              <span class="text-muted">{{ DISPOSITION_LABELS[round.disposition] }}</span>
              <code v-if="round.model" class="text-2xs text-dimmed">{{ round.model }}</code>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </ResultWindowShell>
</template>
