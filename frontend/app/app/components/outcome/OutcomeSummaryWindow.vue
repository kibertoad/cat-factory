<script setup lang="ts">
// The OUTCOME summary — the non-code answer to "what did this run change, and what backs that
// up", and the surface "read the result" lands on in basic mode.
//
// Reading a finished run meant reading a pull request: a branch, a title, a diff. Everything a
// person who does not read diffs needs was already captured and each piece sat behind its own
// step-keyed window, so it was reachable only by someone who had learned the pipeline. This
// window is the one place they come together, keyed by the RUN: what was asked, which
// requirements were verified, how it was tested, what it looks like, and which checks ran. The
// diff is one click from the top of the card rather than the thing you start on.
//
// It composes NOTHING itself: `composeRunOutcome` (`~/utils/runOutcome`) is the pure reduction,
// so the rules that matter (a regression is an `established` requirement observed to fail; an
// absent producer never renders as a clean result) are unit-tested without mounting this. What
// lives here is presentation only, plus the ONE fetch the card owns: the enclosing service's
// spec, which turns the tester's requirement IDS into the requirement TITLES a reader came for.
import { computed, onUnmounted, ref, watch } from 'vue'
import type {
  OutcomeCheckKind,
  OutcomeCheckState,
  OutcomeDisposition,
  OutcomeSpecJoin,
  OutcomeVisual,
  RequirementsGap,
  TestsGap,
  TestsVerdict,
  VisualsGap,
} from '~/utils/runOutcome'
import { composeRunOutcome } from '~/utils/runOutcome'
import { REPRODUCTION_STATUS_KEYS } from '~/utils/reproduction'
import type { RequirementVerdictStatus, TestConcernSeverity } from '~/types/domain'
import type { TestEnvironment } from '@cat-factory/contracts'
import { useArtifactBlobs } from '~/composables/useArtifactBlobs'
import ArtifactLightbox from '~/components/media/ArtifactLightbox.vue'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import EmptyState from '~/components/common/EmptyState.vue'

const board = useBoardStore()
const execution = useExecutionStore()
const serviceSpec = useServiceSpecStore()
const ui = useUiStore()
const { t } = useI18n()

// Per-window blob cache for the captured views; revoked on unmount so the (large) image bytes
// don't outlive the card.
const blobs = useArtifactBlobs()
onUnmounted(() => blobs.revokeAll())

// The shared seam contract. The `onOpen` loader fetches the ENCLOSING SERVICE's spec: the
// requirement verdicts are keyed by the spec's own ids, and without it the coverage section can
// only show ids (which it then says, rather than letting an id read as a title).
const { open, blockId, instanceId, close } = useResultView('outcome', {
  onOpen: (view) => {
    const block = board.getBlock(view.blockId)
    const service = block ? board.serviceOf(block) : undefined
    if (service) void serviceSpec.load(service.id)
  },
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const service = computed(() => (block.value ? board.serviceOf(block.value) : undefined))
const instance = computed(() => {
  // The run carried by the opener, else the block's own live run: a card opened from a
  // notification names the run, one opened from the board does not.
  const id = instanceId.value ?? block.value?.executionId ?? null
  return id ? (execution.getInstance(id) ?? null) : null
})

const outcome = computed(() =>
  block.value
    ? composeRunOutcome({
        block: block.value,
        instance: instance.value,
        spec: service.value ? serviceSpec.viewFor(service.value.id) : null,
      })
    : null,
)

// ---- Presentation maps (exhaustive over the closed unions, so a new member fails the
// typecheck here rather than rendering blank on the one surface whose job is to say what is
// known and what is not).

const DISPOSITION_KEYS: Record<OutcomeDisposition, string> = {
  merged: 'outcome.disposition.merged',
  awaiting_merge: 'outcome.disposition.awaiting_merge',
  in_flight: 'outcome.disposition.in_flight',
  needs_attention: 'outcome.disposition.needs_attention',
  not_run: 'outcome.disposition.not_run',
  unknown: 'outcome.disposition.unknown',
}
/** The badge palette, named once so every colour map below is checked against it. */
type BadgeColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

const DISPOSITION_COLOR: Record<OutcomeDisposition, BadgeColor> = {
  merged: 'success',
  awaiting_merge: 'info',
  in_flight: 'primary',
  needs_attention: 'error',
  not_run: 'neutral',
  unknown: 'neutral',
}

// A run this card could not resolve is the SAME fact in every section, so all three name one
// key: it is about the read, not about what any particular producer did or did not do.
const RUN_UNAVAILABLE_KEY = 'outcome.gap.run_unavailable'

const REQUIREMENTS_GAP_KEYS: Record<RequirementsGap, string> = {
  run_unavailable: RUN_UNAVAILABLE_KEY,
  no_tester_step: 'outcome.requirements.gap.no_tester_step',
  tester_not_reported: 'outcome.requirements.gap.tester_not_reported',
  no_verdicts: 'outcome.requirements.gap.no_verdicts',
  no_requirements: 'outcome.requirements.gap.no_requirements',
}
const TESTS_GAP_KEYS: Record<TestsGap, string> = {
  run_unavailable: RUN_UNAVAILABLE_KEY,
  no_tester_step: 'outcome.tests.gap.no_tester_step',
  tester_not_reported: 'outcome.tests.gap.tester_not_reported',
}
const VISUALS_GAP_KEYS: Record<VisualsGap, string> = {
  run_unavailable: RUN_UNAVAILABLE_KEY,
  no_visual_step: 'outcome.visuals.gap.no_visual_step',
  none_captured: 'outcome.visuals.gap.none_captured',
}
/**
 * Why the rows carry no spec titles. `joined` is excluded rather than mapped to an empty
 * string, so the note renders only where there is one to make and a new join state cannot ship
 * without copy of its own.
 */
const SPEC_JOIN_KEYS: Record<Exclude<OutcomeSpecJoin, 'joined'>, string> = {
  not_read: 'outcome.requirements.spec.not_read',
}

const VERDICT_META: Record<RequirementVerdictStatus, { color: string; key: string }> = {
  met: { color: '#22c55e', key: 'outcome.requirements.verdict.met' },
  not_met: { color: '#ef4444', key: 'outcome.requirements.verdict.not_met' },
  not_covered: { color: '#64748b', key: 'outcome.requirements.verdict.not_covered' },
}
const SEVERITY_KEYS: Record<TestConcernSeverity, string> = {
  low: 'outcome.tests.severity.low',
  medium: 'outcome.tests.severity.medium',
  high: 'outcome.tests.severity.high',
  critical: 'outcome.tests.severity.critical',
}
const SEVERITY_COLOR: Record<TestConcernSeverity, BadgeColor> = {
  low: 'neutral',
  medium: 'warning',
  high: 'warning',
  critical: 'error',
}
const ENVIRONMENT_KEYS: Record<TestEnvironment, string> = {
  local: 'outcome.tests.environment.local',
  ephemeral: 'outcome.tests.environment.ephemeral',
}
const CHECK_KEYS: Record<OutcomeCheckKind, string> = {
  ci: 'outcome.checks.kind.ci',
  validation: 'outcome.checks.kind.validation',
  reproduction: 'outcome.checks.kind.reproduction',
}
const CHECK_STATE_KEYS: Record<OutcomeCheckState, string> = {
  pass: 'outcome.checks.state.pass',
  fail: 'outcome.checks.state.fail',
  pending: 'outcome.checks.state.pending',
  inconclusive: 'outcome.checks.state.inconclusive',
}
const CHECK_STATE_COLOR: Record<OutcomeCheckState, BadgeColor> = {
  pass: 'success',
  fail: 'error',
  pending: 'info',
  inconclusive: 'warning',
}
const TESTS_VERDICT_KEYS: Record<TestsVerdict, string> = {
  greenlit: 'outcome.tests.verdict.greenlit',
  concerns: 'outcome.tests.verdict.concerns',
  could_not_run: 'outcome.tests.verdict.could_not_run',
}
const TESTS_VERDICT_COLOR: Record<TestsVerdict, BadgeColor> = {
  greenlit: 'success',
  concerns: 'warning',
  could_not_run: 'error',
}

// ---- Derived view state ----------------------------------------------------

const headerTitle = computed(() => outcome.value?.title ?? t('outcome.title'))
const disposition = computed(() => outcome.value?.disposition ?? 'not_run')

/**
 * The note under the requirement counts when the section was NOT counted against the service's
 * `spec/`, null when it was. It is a statement about the DENOMINATOR, not about missing titles:
 * an unjoined section counts only what the tester chose to rule on and says nothing about what it
 * skipped. Resolved here so the `joined` exclusion is checked by the compiler once, rather than by
 * a template condition that would silently render nothing if the union grew.
 */
const specNote = computed(() => {
  const requirements = outcome.value?.requirements
  if (!requirements || requirements.status !== 'reported' || requirements.spec === 'joined') {
    return null
  }
  return t(SPEC_JOIN_KEYS[requirements.spec])
})

/** The requirement rows, in the composer's severity-first order. */
const requirementRows = computed(() => {
  const requirements = outcome.value?.requirements
  return requirements?.status === 'reported' ? requirements.entries : []
})

/**
 * How many verdicts the tester returned against ids this service's `spec/` does not carry, or 0.
 *
 * Surfaced because the counts above are the SPEC's and this number is the difference between them
 * and the tester's own tally. Unstated, a reader comparing the two reads the gap as one of the two
 * being wrong, when it is really a spec that moved on under the tester.
 */
const unmatchedVerdicts = computed(() => {
  const requirements = outcome.value?.requirements
  return requirements?.status === 'reported' ? requirements.unmatchedVerdicts : 0
})

/** The captured views, resolved to blobs as they arrive (the card shows them inline). */
const views = computed(() =>
  outcome.value?.visuals.status === 'reported' ? outcome.value.visuals.views : [],
)
watch(
  views,
  (next) => {
    for (const v of next) if (v.artifactId) void blobs.resolve(v.artifactId)
  },
  { immediate: true },
)

const lightboxItems = computed(() =>
  views.value.flatMap((v) =>
    v.artifactId
      ? [
          {
            artifactId: v.artifactId,
            label: v.view,
            alt: t('outcome.visuals.shotAlt', { view: v.view }),
          },
        ]
      : [],
  ),
)
const lightboxOpen = ref(false)
const lightboxIndex = ref(0)
/**
 * Open the zoom viewer on a captured view. A view whose capture is missing has nothing to open.
 *
 * The viewer's index is counted over the views that HAVE a capture, in order, rather than
 * looked up by artifact id: two views of one artifact (a gate that captured a shared reference,
 * a re-captured view) are distinct rows that would otherwise both open the first of them.
 */
function openShot(view: OutcomeVisual, position: number) {
  if (!view.artifactId) return
  lightboxIndex.value = views.value.slice(0, position).filter((v) => v.artifactId).length
  lightboxOpen.value = true
}

/**
 * The recorded machine checks as chips. The reproduction row names its OWN verdict through the
 * shared presentation map instead of the generic state word: `inconclusive` and
 * `declared_infeasible` are both "not proof" and call for different reactions, so collapsing
 * them onto one label is the reporting failure this card exists to avoid.
 */
const checkRows = computed(() =>
  (outcome.value?.checks ?? []).map((check) => ({
    kind: check.kind,
    color: CHECK_STATE_COLOR[check.state],
    label: t('outcome.checks.row', {
      kind: t(CHECK_KEYS[check.kind]),
      state: check.reproduction
        ? t(REPRODUCTION_STATUS_KEYS[check.reproduction].chip)
        : t(CHECK_STATE_KEYS[check.state]),
    }),
  })),
)

/** Drill into the full test report (this card is the summary, never a replacement for it). */
function openTestReport() {
  if (instance.value) ui.openTestEvidence(instance.value.id)
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-clipboard-check"
    icon-class="bg-sky-500/15 text-sky-300"
    :title="headerTitle"
    :subtitle="t('outcome.subtitle')"
    width="3xl"
    testid="outcome-window"
    @close="close"
  >
    <div v-if="outcome" class="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="outcome-body">
      <!-- Where the work stands, and the way to the diff. The pull requests sit at the TOP so
           the code is exactly one click from the summary rather than the thing you start on. -->
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <UBadge
          :color="DISPOSITION_COLOR[disposition]"
          variant="subtle"
          size="md"
          data-testid="outcome-disposition"
          :data-disposition="disposition"
        >
          {{ t(DISPOSITION_KEYS[disposition]) }}
        </UBadge>
        <UButton
          v-for="pr in outcome.pullRequests"
          :key="pr.url"
          :to="pr.url"
          target="_blank"
          rel="noopener"
          external
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-git-pull-request"
          trailing-icon="i-lucide-external-link"
          data-testid="outcome-pr-link"
        >
          {{
            pr.repo
              ? t('outcome.peerDiff', { repo: pr.repo })
              : pr.number
                ? t('outcome.diffNumbered', { number: pr.number })
                : t('outcome.diff')
          }}
        </UButton>
      </div>

      <!-- What was asked, in the requester's own words. -->
      <section class="mb-5">
        <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {{ t('outcome.ask.title') }}
        </h3>
        <MarkdownProse
          v-if="outcome.ask"
          :text="outcome.ask"
          class="text-[13px] leading-relaxed text-slate-300"
          data-testid="outcome-ask"
        />
        <p v-else class="text-[13px] italic leading-relaxed text-slate-500">
          {{ t('outcome.ask.none') }}
        </p>
      </section>

      <!-- Requirement coverage: which required behaviours were checked, and what was seen. -->
      <section class="mb-5" data-testid="outcome-requirements">
        <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {{ t('outcome.requirements.title') }}
        </h3>
        <template v-if="outcome.requirements.status === 'reported'">
          <div class="mb-2 flex flex-wrap items-center gap-1.5">
            <UBadge color="success" variant="subtle" size="sm">
              {{ t('outcome.requirements.met', { count: outcome.requirements.met }) }}
            </UBadge>
            <UBadge color="error" variant="subtle" size="sm">
              {{ t('outcome.requirements.notMet', { count: outcome.requirements.notMet }) }}
            </UBadge>
            <UBadge color="neutral" variant="subtle" size="sm">
              {{ t('outcome.requirements.notCovered', { count: outcome.requirements.notCovered }) }}
            </UBadge>
            <UBadge
              v-if="outcome.requirements.regressions > 0"
              color="error"
              variant="solid"
              size="sm"
              icon="i-lucide-triangle-alert"
              data-testid="outcome-regressions"
            >
              {{
                t('outcome.requirements.regressions', {
                  count: outcome.requirements.regressions,
                })
              }}
            </UBadge>
          </div>
          <!-- The coverage was not counted against the spec, so say what the numbers above do
               and do not cover rather than letting them read as the whole picture. -->
          <p
            v-if="specNote"
            class="mb-2 text-[11px] leading-relaxed text-amber-300/90"
            data-testid="outcome-spec-note"
          >
            {{ specNote }}
          </p>
          <!-- The tester ruled on ids the spec does not carry, so its own tally and the counts
               above legitimately differ. Said out loud, because the alternative is a reader
               deciding which of the two numbers to distrust. -->
          <p
            v-if="unmatchedVerdicts > 0"
            class="mb-2 text-[11px] leading-relaxed text-amber-300/90"
            data-testid="outcome-unmatched-verdicts"
          >
            {{ t('outcome.requirements.unmatchedVerdicts', { count: unmatchedVerdicts }) }}
          </p>
          <ul class="space-y-1.5">
            <li
              v-for="req in requirementRows"
              :key="req.id"
              class="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-950/40 p-2"
              data-testid="outcome-requirement"
            >
              <span
                class="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                :style="{ backgroundColor: VERDICT_META[req.verdict].color }"
              />
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-[13px] text-slate-200">{{ req.title ?? req.id }}</span>
                  <UBadge
                    v-if="req.regression"
                    color="error"
                    variant="subtle"
                    size="sm"
                    data-testid="outcome-requirement-regression"
                  >
                    {{ t('outcome.requirements.regressionTag') }}
                  </UBadge>
                  <span class="text-[10px] uppercase tracking-wide text-slate-500">
                    {{ t(VERDICT_META[req.verdict].key) }}
                  </span>
                </div>
                <p v-if="req.detail" class="mt-0.5 text-[12px] leading-relaxed text-slate-400">
                  {{ req.detail }}
                </p>
              </div>
            </li>
          </ul>
        </template>
        <p v-else class="text-[13px] italic leading-relaxed text-slate-500">
          {{ t(REQUIREMENTS_GAP_KEYS[outcome.requirements.gap]) }}
        </p>
      </section>

      <!-- How it was tested: the tester's own verdict and prose, attributed as its account. -->
      <section class="mb-5" data-testid="outcome-tests">
        <div class="mb-1.5 flex flex-wrap items-center gap-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {{ t('outcome.tests.title') }}
          </h3>
          <UBadge
            v-if="outcome.tests.status === 'reported'"
            :color="TESTS_VERDICT_COLOR[outcome.tests.verdict]"
            variant="subtle"
            size="sm"
            data-testid="outcome-tests-verdict"
          >
            {{ t(TESTS_VERDICT_KEYS[outcome.tests.verdict]) }}
          </UBadge>
          <UBadge
            v-if="outcome.tests.status === 'reported' && outcome.tests.environment"
            color="neutral"
            variant="subtle"
            size="sm"
          >
            {{ t(ENVIRONMENT_KEYS[outcome.tests.environment]) }}
          </UBadge>
          <UButton
            v-if="outcome.tests.status === 'reported' && instance"
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-flask-conical"
            data-testid="outcome-open-test-report"
            @click="openTestReport"
          >
            {{ t('outcome.tests.openReport') }}
          </UButton>
        </div>
        <template v-if="outcome.tests.status === 'reported'">
          <p
            v-if="outcome.tests.abortReason"
            class="mb-2 rounded-md border border-rose-900/70 bg-rose-500/10 p-2 text-[13px] leading-relaxed text-rose-200"
            data-testid="outcome-tests-abort"
          >
            {{ t('outcome.tests.abort', { reason: outcome.tests.abortReason }) }}
          </p>
          <p v-if="outcome.tests.summary" class="text-[13px] leading-relaxed text-slate-300">
            {{ t('outcome.tests.summary', { summary: outcome.tests.summary }) }}
          </p>
          <p class="mt-1.5 text-[12px] text-slate-400">
            {{
              t('outcome.tests.counts', {
                passed: outcome.tests.passed,
                failed: outcome.tests.failed,
                skipped: outcome.tests.skipped,
              })
            }}
          </p>
          <ul v-if="outcome.tests.concerns.length" class="mt-2 space-y-1">
            <li
              v-for="(concern, i) in outcome.tests.concerns"
              :key="i"
              class="flex items-start gap-2 text-[12px] text-slate-300"
              data-testid="outcome-concern"
            >
              <UBadge :color="SEVERITY_COLOR[concern.severity]" variant="subtle" size="sm">
                {{ t(SEVERITY_KEYS[concern.severity]) }}
              </UBadge>
              <span class="min-w-0">{{ concern.title }}</span>
            </li>
          </ul>
        </template>
        <p v-else class="text-[13px] italic leading-relaxed text-slate-500">
          {{ t(TESTS_GAP_KEYS[outcome.tests.gap]) }}
        </p>
      </section>

      <!-- What it looks like: the captured views, and whether a human was asked about them. -->
      <section class="mb-5" data-testid="outcome-visuals">
        <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {{ t('outcome.visuals.title') }}
        </h3>
        <template v-if="outcome.visuals.status === 'reported'">
          <p class="mb-2 text-[12px] leading-relaxed text-slate-400">
            {{
              outcome.visuals.source === 'visual_confirm'
                ? t('outcome.visuals.source.visual_confirm')
                : t('outcome.visuals.source.tester')
            }}
          </p>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button
              v-for="(view, position) in outcome.visuals.views"
              :key="`${position}:${view.view}`"
              type="button"
              class="group overflow-hidden rounded-md border border-slate-800 bg-slate-950/60 text-start transition hover:border-slate-600"
              :disabled="!view.artifactId"
              data-testid="outcome-shot"
              @click="openShot(view, position)"
            >
              <img
                v-if="view.artifactId && blobs.urlFor(view.artifactId)"
                :src="blobs.urlFor(view.artifactId)"
                :alt="t('outcome.visuals.shotAlt', { view: view.view })"
                class="h-24 w-full object-cover object-top"
              />
              <div v-else class="flex h-24 w-full items-center justify-center text-slate-600">
                <UIcon
                  :name="
                    view.artifactId && blobs.statusFor(view.artifactId) === 'error'
                      ? 'i-lucide-image-off'
                      : 'i-lucide-image'
                  "
                  class="h-5 w-5"
                />
              </div>
              <span
                class="flex items-center gap-1 truncate px-1.5 py-1 text-[11px] text-slate-300"
                :title="view.view"
              >
                <UIcon
                  v-if="view.referenceArtifactId"
                  name="i-lucide-images"
                  class="h-3 w-3 shrink-0 text-sky-300"
                  :title="t('outcome.visuals.hasReference')"
                />
                {{ view.view }}
              </span>
            </button>
          </div>
        </template>
        <template v-else>
          <p class="text-[13px] italic leading-relaxed text-slate-500">
            {{ t(VISUALS_GAP_KEYS[outcome.visuals.gap]) }}
          </p>
          <p
            v-if="outcome.visuals.detail"
            class="mt-1 text-[12px] leading-relaxed text-slate-500"
            data-testid="outcome-visuals-detail"
          >
            {{ outcome.visuals.detail }}
          </p>
        </template>
      </section>

      <!-- The machine checks, listed only where one actually recorded a verdict. -->
      <section v-if="checkRows.length" data-testid="outcome-checks">
        <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {{ t('outcome.checks.title') }}
        </h3>
        <div class="flex flex-wrap items-center gap-1.5">
          <UBadge
            v-for="check in checkRows"
            :key="check.kind"
            :color="check.color"
            variant="subtle"
            size="sm"
            data-testid="outcome-check"
            :data-check="check.kind"
          >
            {{ check.label }}
          </UBadge>
        </div>
      </section>
    </div>

    <EmptyState
      v-else
      icon="i-lucide-clipboard-check"
      :title="t('outcome.empty.title')"
      :description="t('outcome.empty.body')"
    />
  </ResultWindowShell>

  <!-- Shared zoom/pan viewer, layered above this window on the shared modal stack. -->
  <ArtifactLightbox
    v-model:open="lightboxOpen"
    v-model:index="lightboxIndex"
    :items="lightboxItems"
    :blobs="blobs"
  />
</template>
