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
// lives here is presentation only, plus the ONE fetch the card owns: the spec THIS RUN was
// judged against, which turns the tester's requirement IDS into the TITLES a reader came for.
import { computed, onUnmounted, ref, watch } from 'vue'
import type {
  EnvironmentsGap,
  OutcomeCheckKind,
  OutcomeCheckState,
  OutcomeDisposition,
  OutcomeEnvironmentOrigin,
  OutcomeEnvironmentState,
  OutcomeSource,
  OutcomeSpecJoin,
  OutcomeVisual,
  RequirementsGap,
  SourcesGap,
  TestsGap,
  TestsVerdict,
  VisualsGap,
} from '~/utils/runOutcome'
import { composeRunOutcome } from '~/utils/runOutcome'
import { GAP_KEYS } from '~/components/documents/DocumentSyncState.logic'
import DocumentOriginLink from '~/components/documents/DocumentOriginLink.vue'
import { REPRODUCTION_STATUS_KEYS } from '~/utils/reproduction'
import type { RequirementVerdictStatus, TestConcernSeverity } from '~/types/domain'
import type { TestEnvironment } from '@cat-factory/contracts'
import { useArtifactBlobs } from '~/composables/useArtifactBlobs'
import { useNowTick } from '~/composables/useStepTimer'
import { readEnvironmentAgainstClock } from '~/components/outcome/OutcomeSummaryWindow.logic'
import ArtifactLightbox from '~/components/media/ArtifactLightbox.vue'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import EmptyState from '~/components/common/EmptyState.vue'
import type { BadgeColor } from '~/utils/badge'

const board = useBoardStore()
const documents = useDocumentsStore()
const execution = useExecutionStore()
const serviceSpec = useServiceSpecStore()
const ui = useUiStore()
const { t, d } = useI18n()

// The wall clock this card reads a TTL against. Coarse on purpose: an environment's expiry is
// the only thing here that moves with time, and a per-second tick would re-render the whole card
// for a boundary that matters at minute granularity.
const nowTick = useNowTick(30_000)

// Per-window blob cache for the captured views; revoked on unmount so the (large) image bytes
// don't outlive the card.
const blobs = useArtifactBlobs()
onUnmounted(() => blobs.revokeAll())

// The shared seam contract.
const { open, blockId, instanceId, close } = useResultView('outcome')

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const runId = computed(() => {
  // The run carried by the opener, else the block's own live run: a card opened from a
  // notification names the run, one opened from the board does not.
  return instanceId.value ?? block.value?.executionId ?? null
})
const instance = computed(() => (runId.value ? (execution.getInstance(runId.value) ?? null) : null))

// The ONE fetch this card owns: the spec THIS RUN was judged against. Requirement verdicts are
// keyed by the spec's own ids, and without the spec the coverage section can only show ids
// (which it then says, rather than letting an id read as a title).
//
// Keyed by the RUN, not by the enclosing service, and that is a correctness matter rather than a
// cache detail: the service read comes from the repo's default branch, so for as long as the
// run's pull request is open it is missing exactly the requirements the run added and the tester
// just ruled on. Every one of those verdicts joined against nothing and rendered as "not
// checked", and the card's counts contradicted `GET /api/v1/runs/:runId/outcome` for one run.
//
// A watch rather than the `onOpen` hook, because the run id can arrive after the block does (a
// card open on a task that starts a run) and the join must follow it.
watch(
  runId,
  (id) => {
    if (id) void serviceSpec.loadForRun(id)
  },
  { immediate: true },
)

const outcome = computed(() =>
  block.value
    ? composeRunOutcome({
        block: block.value,
        instance: instance.value,
        spec: runId.value ? serviceSpec.viewForRun(runId.value) : null,
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
const SOURCES_GAP_KEYS: Record<SourcesGap, string> = {
  run_unavailable: RUN_UNAVAILABLE_KEY,
  none_linked: 'outcome.sources.gap.none_linked',
}
const ENVIRONMENTS_GAP_KEYS: Record<EnvironmentsGap, string> = {
  run_unavailable: RUN_UNAVAILABLE_KEY,
  no_environment_step: 'outcome.environments.gap.no_environment_step',
  not_provisioned: 'outcome.environments.gap.not_provisioned',
  infraless: 'outcome.environments.gap.infraless',
}
const ENVIRONMENT_STATE_KEYS: Record<OutcomeEnvironmentState, string> = {
  live: 'outcome.environments.state.live',
  provisioning: 'outcome.environments.state.provisioning',
  failed: 'outcome.environments.state.failed',
  reclaiming: 'outcome.environments.state.reclaiming',
  reclaimed: 'outcome.environments.state.reclaimed',
  expired: 'outcome.environments.state.expired',
}
const ENVIRONMENT_STATE_COLOR: Record<OutcomeEnvironmentState, BadgeColor> = {
  live: 'success',
  provisioning: 'info',
  failed: 'error',
  reclaiming: 'neutral',
  reclaimed: 'neutral',
  expired: 'neutral',
}
/**
 * Where the row came from, said out loud. `projected` is the one that changes what a reader
 * should conclude (nothing has settled yet, so this row can still move), and the three are
 * mapped exhaustively so a new producer cannot ship as a blank line.
 */
const ENVIRONMENT_ORIGIN_KEYS: Record<OutcomeEnvironmentOrigin, string> = {
  deployer: 'outcome.environments.origin.deployer',
  human_test: 'outcome.environments.origin.human_test',
  projected: 'outcome.environments.origin.projected',
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

/**
 * What one linked page's row says about how current the copy the agents read was.
 *
 * Four outcomes, and none of them may collapse into another: a named revision to check the work
 * against, a copy nobody could confirm (a warning about the WORK, not about the platform), a body
 * with no source to trail, and a deployment that runs no freshness check at all. The last two are
 * the pair a dash would merge, and they are opposite facts about whether anything is missing.
 */
function revisionLabel(freshness: OutcomeSource['freshness']): string {
  if (!freshness) return t('outcome.sources.unchecked')
  switch (freshness.status) {
    case 'confirmed':
      return t('documents.freshness.revision', { version: freshness.version })
    case 'not-applicable':
      return t('outcome.sources.noSource')
    case 'unconfirmed':
      return t(GAP_KEYS[freshness.reason])
    default:
      return exhaustiveFreshness(freshness)
  }
}

/** Compile-time totality: a new verdict member fails the build rather than rendering a blank. */
function exhaustiveFreshness(freshness: never): string {
  return String(freshness)
}

/**
 * The linked pages with their labels resolved, so the exhaustive mapping above is applied once
 * per row rather than on every re-render, and the template stays a list.
 */
const sourceRows = computed(() => {
  const sources = outcome.value?.sources
  if (!sources || sources.status !== 'reported') return []
  return sources.sources.map((source) => ({
    ...source,
    icon: documents.descriptorForOrigin(source.origin)?.icon ?? 'i-lucide-file-text',
    revision: revisionLabel(source.freshness),
  }))
})

/**
 * The environments the run stood up, with everything the row needs resolved once.
 *
 * The TTL is applied HERE rather than in the reduction, and that division is deliberate: the
 * payload is clock-free so the endpoint's answer and this card's live composition cannot
 * disagree about one run, and this surface is the one with a clock to say what the instant it
 * carries means now. The rule itself lives in `OutcomeSummaryWindow.logic.ts`, where it is
 * asserted without mounting the card.
 *
 * The frame is named by its BLOCK title where the board has it. A frame id says nothing to the
 * person this card is for, so an unresolvable one renders as no label rather than as an id.
 */
const environmentRows = computed(() => {
  const environments = outcome.value?.environments
  if (!environments || environments.status !== 'reported') return []
  return environments.entries.map((entry, index) => ({
    ...readEnvironmentAgainstClock(entry, nowTick.value),
    key: `${index}:${entry.environmentId ?? entry.url ?? entry.frameId ?? 'env'}`,
    service: entry.frameId ? (board.getBlock(entry.frameId)?.title ?? null) : null,
  }))
})

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

      <!-- What the run built FROM, and which revision of it. Directly under the ask, because it
           is the rest of the brief: the description is what a person wrote, this is what the
           agents actually read, and every section below is a statement about work done against
           it. A design that moved mid-run is the reading that changes all of them. -->
      <section class="mb-5" data-testid="outcome-sources">
        <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {{ t('outcome.sources.title') }}
        </h3>
        <div v-if="outcome.sources.status === 'reported'" class="space-y-1">
          <div
            v-for="source in sourceRows"
            :key="`${source.origin}:${source.url || source.title}`"
            class="rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5"
            data-testid="outcome-source"
          >
            <DocumentOriginLink
              :url="source.url ?? ''"
              class="flex items-center gap-1.5 text-xs text-slate-300"
              hover-class="hover:text-white"
            >
              <UIcon :name="source.icon" class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
              <span class="truncate">{{ source.title }}</span>
            </DocumentOriginLink>
            <p class="mt-0.5 text-[11px] text-slate-500" data-testid="outcome-source-revision">
              {{ source.revision }}
            </p>
            <!-- Stated separately from the revision above: the last revision alone says the run
                 ENDED current, and says nothing about the step that finished before the page
                 changed under it. -->
            <p
              v-if="source.movedDuringRun"
              class="mt-0.5 text-[11px] text-amber-300"
              data-testid="outcome-source-moved"
            >
              {{ t('outcome.sources.moved') }}
            </p>
          </div>
        </div>
        <p v-else class="text-[13px] italic leading-relaxed text-slate-500">
          {{ t(SOURCES_GAP_KEYS[outcome.sources.gap]) }}
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

      <!-- Where to go and look: the running preview, which is the verification a person who does
           not read diffs starts from. Beside the captured views on purpose: the shots are what
           this run saw, this is the thing itself. -->
      <section class="mb-5" data-testid="outcome-environments">
        <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {{ t('outcome.environments.title') }}
        </h3>
        <template v-if="outcome.environments.status === 'reported'">
          <div
            v-for="row in environmentRows"
            :key="row.key"
            class="mb-2 rounded-md border border-slate-800 bg-slate-950/40 px-2.5 py-2 last:mb-0"
            data-testid="outcome-environment"
            :data-state="row.state"
          >
            <div class="flex flex-wrap items-center gap-2">
              <UBadge :color="ENVIRONMENT_STATE_COLOR[row.state]" variant="subtle" size="sm">
                {{ t(ENVIRONMENT_STATE_KEYS[row.state]) }}
              </UBadge>
              <span v-if="row.service" class="truncate text-[12px] text-slate-300">
                {{ row.service }}
              </span>
              <span class="text-[11px] text-slate-500">
                {{ t(ENVIRONMENT_ORIGIN_KEYS[row.origin]) }}
              </span>
            </div>
            <UButton
              v-if="row.openable"
              :to="row.url ?? undefined"
              target="_blank"
              rel="noopener"
              external
              color="primary"
              variant="soft"
              size="xs"
              class="mt-1.5"
              icon="i-lucide-external-link"
              data-testid="outcome-environment-open"
            >
              {{ t('outcome.environments.open') }}
            </UButton>
            <p
              v-else-if="row.url"
              class="mt-1.5 break-all text-[12px] text-slate-500"
              data-testid="outcome-environment-url"
            >
              {{ row.url }}
            </p>
            <p v-if="row.retained" class="mt-1 text-[11px] text-slate-400">
              {{ t('outcome.environments.retained') }}
            </p>
            <p v-if="row.expiresAt" class="mt-1 text-[11px] text-slate-500">
              {{
                row.lapsed
                  ? t('outcome.environments.expired', { date: d(new Date(row.expiresAt), 'long') })
                  : t('outcome.environments.expires', { date: d(new Date(row.expiresAt), 'long') })
              }}
            </p>
            <p
              v-if="row.detail"
              class="mt-1 break-words text-[12px] leading-relaxed text-slate-500"
              data-testid="outcome-environment-detail"
            >
              {{ row.detail }}
            </p>
          </div>
        </template>
        <p v-else class="text-[13px] italic leading-relaxed text-slate-500">
          {{ t(ENVIRONMENTS_GAP_KEYS[outcome.environments.gap]) }}
        </p>
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
