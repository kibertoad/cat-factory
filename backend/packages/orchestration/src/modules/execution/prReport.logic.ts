import type {
  Block,
  ExecutionInstance,
  MergeAssessment,
  MergeDecision,
  PipelineStep,
  PrReportCheck,
  PrReportIssue,
  PrReportJudge,
  PrReportRequirement,
  PrReportScope,
  PrVerificationReport,
  RequirementVerdict,
  SpecDoc,
  TestReport,
} from '@cat-factory/kernel'
import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'
import { PR_VERIFICATION_REPORT_VERSION } from '@cat-factory/contracts'
import { CI_AGENT_KIND, MERGER_AGENT_KIND, isTesterKind } from './ci.logic.js'
import {
  type PrReportEnvironmentInputs,
  composeEnvironments,
  renderEnvironments,
} from './prReport.environments.js'
import {
  composeReproduction,
  composeValidation,
  makeOutputCapper,
  renderReproduction,
  renderValidation,
} from './prReport.commands.js'
import { absentNote, findStep } from './prReport.steps.js'

// ---------------------------------------------------------------------------
// The PR verification report's PURE half: compose it from a run's already-loaded state, and
// render it as markdown + a fenced JSON block.
//
// Everything here reads the `ExecutionInstance` the engine already holds in memory — the CI
// gate's recorded verdict (`step.gate`), the tester's last report (`step.test`), the
// deployer's per-frame outcomes (`step.deployEnvs`) and the merger's resolved decision
// (`step.custom`). Nothing re-probes a provider: a re-probe costs a round trip AND can
// disagree with the verdict the gate actually acted on, which would make the report a
// worse record than the run it describes.
//
// The TEST ENVIRONMENT LIFECYCLE section lives next door in `prReport.environments.ts`: it is
// the one section composed from a source outside the in-memory run (the provisioning event log,
// which is what dates the bring-up and the teardown), and it joins three producers into one
// computed proof. The caller resolves its inputs and passes them in, so this file stays the
// report's spine.
//
// Sections whose producing step did not run are emitted with `status: 'absent'` and a `note`
// that SAYS so. A silently missing section is indistinguishable from a clean one, which is
// exactly the false reassurance this feature exists to remove.
//
// Every free-text value the run produced (a tester summary, a merge rationale, a provisioner's
// stderr) is SCRUBBED here with the same `redactSecrets` the telemetry store uses. A PR body
// is a strictly more exposed surface than the private telemetry DB — it may be a public repo —
// so anything worth scrubbing before it reaches our own database is worth scrubbing before it
// reaches the host. Scrubbing at COMPOSE time (rather than over the rendered markdown) keeps
// the human prose and the machine-readable JSON block consistent: both are produced from this
// one already-scrubbed object. Rendering-level hazards (auto-linked mentions and issue
// references, table-breaking newlines, unbalanced code fences) are handled at the interpolation
// boundary — see kernel's `hostMarkdown` boundary.
// ---------------------------------------------------------------------------

/** Scrub credentials out of an optional free-text value, preserving `null`/`undefined`. */
function scrub(value: string | null | undefined): string | null {
  return value == null ? null : (redactSecrets(value) ?? null)
}

/** Scrub a required free-text value. */
function scrubbed(value: string): string {
  return redactSecrets(value) ?? ''
}

/**
 * The ONE shape a truncation note takes, so the report's own log never speaks two dialects: a
 * reader who learns to read one note can read all of them. `detail` is for a list whose cap is
 * not a plain prefix — see {@link selectRequirementEntries}.
 */
function truncationNote(label: string, kept: number, total: number, detail?: string): string {
  return `${label}: showing ${kept} of ${total}${detail ? ` (${detail})` : ''}`
}

/**
 * Cap a list, recording what was dropped in the report's own `truncations` log.
 *
 * A silently shortened list is the same failure this feature exists to remove: 50 of 112
 * failing checks reads exactly like "112 checks, 50 failed". The report SAYS what it left out.
 */
function cap<T>(items: readonly T[], label: string, truncations: string[]): T[] {
  const { items: kept, dropped } = hostMarkdown.capList(items)
  if (dropped > 0) truncations.push(truncationNote(label, kept.length, items.length))
  return kept
}

/**
 * Scrub a requirement verdict's evidence and clamp it to what the table can actually show.
 * The rendered cell is truncated at {@link hostMarkdown.MAX_CELL_CHARS} regardless, so
 * carrying more than that into the report only inflates the machine-readable JSON block —
 * which the body-size backstop then drops WHOLESALE. One pathological tester `detail` should
 * not cost the reader the entire JSON block.
 */
function verdictDetail(value: string | null | undefined): string | null {
  const text = scrub(value)
  if (!text) return null
  if (text.length <= hostMarkdown.MAX_CELL_CHARS) return text
  return `${text.slice(0, hostMarkdown.MAX_CELL_CHARS - 1)}…`
}

/** The non-run inputs the composer needs beyond the instance itself. */
export interface PrReportInputs {
  block: Block
  /** Tracker issues linked to the task (one `listByBlock` read — never a per-issue loop). */
  issues: PrReportIssue[]
  /** `owner/name` of the repo the run targeted, when resolved. */
  repo?: string | null
  /** The VCS provider that repo lives on (neutral vocabulary — never assumed GitHub). */
  provider?: 'github' | 'gitlab' | null
  /** Deep link into the run's observability panel; null when no public app URL is configured. */
  runUrl: string | null
  /**
   * The two MACHINE links, built from the deployment's public backend URL: the run's tool-call
   * trajectory and this report served live. Null when no such URL is configured, exactly as
   * {@link PrReportInputs.runUrl} is for the app link.
   */
  trajectoryUrl: string | null
  reportUrl: string | null
  /**
   * The service's in-repo `spec/` tree, reassembled from the run's branch, for the
   * requirement → evidence join. `null`/absent when it could not be read at all (no VCS
   * wired, no repo resolved, a transport failure) — which the section reports distinctly from
   * a spec that IS readable but records no requirements.
   */
  spec?: SpecDoc | null
  /**
   * The environment-lifecycle section's own resolved inputs: the run's rows in the provisioning
   * event log (the DATED half of the up → observed → torn-down proof) and the deep link into
   * its captured evidence. See `prReport.environments.ts`.
   */
  environments: PrReportEnvironmentInputs
  /**
   * WHICH of a multi-repo run's pull requests this report is being composed for. Absent ⇒ the
   * own-service PR, which is every single-repo run and the shape the report had before peer
   * reports existed.
   *
   * A `peer` scope withholds the three OWN-SERVICE-only sections rather than restating them;
   * see {@link ownServiceOnly}.
   */
  scope?: PrReportScope
  /** Epoch ms stamped as the report's `generatedAt`. */
  now: number
}

/**
 * The absent-section note a PEER repo's report carries in place of an own-service-only section.
 *
 * These three sections are statements about the OWN-SERVICE repo: pre-PR validation ran that
 * service's configured check commands, the reproduction proof ran against that repo's tree, and
 * the requirement join reads that service's in-repo `spec/`. None of them was computed for this
 * repo, so restating them here would attribute one repo's evidence to another repo's diff — a
 * green validation block on a peer PR reads as "this repo's checks passed" when this repo's
 * checks were never run.
 *
 * Withheld LOUDLY, with a pointer to where the evidence actually is, because a silently missing
 * section reads exactly like a clean one (the report's governing rule). The pointer degrades
 * honestly: a run whose own-service PR is not open yet says so rather than naming a PR that
 * does not exist.
 */
function ownServiceOnly(what: string, scope: PrReportScope): string {
  const own = scope.ownPullRequest
  const where = own
    ? `on the own-service pull request (${own.repo}#${own.number})`
    : 'on the own-service pull request, which this run has not opened yet'
  return (
    `Not computed for this repository: ${what} runs against the task's own service, ` +
    `not against a connected service's repo. It is reported ${where}.`
  )
}

/** True when this report is being composed for a peer repo's pull request. */
function isPeer(scope: PrReportScope | undefined): boolean {
  return scope?.role === 'peer'
}

/** A step is "settled" once it finished — a pending step has no evidence to report yet. */
function settled(step: PipelineStep | undefined): boolean {
  return !!step && (step.state === 'done' || step.progress >= 1)
}

/**
 * The CI gate's verdict, as recorded on the gate step.
 *
 * The verdict itself is RUN-scoped on a multi-repo task and deliberately reported unchanged on
 * every PR: the gate reduces the check runs across all of the run's repos to one verdict, and
 * that one verdict is what blocks the merge of every PR in the set. Reporting only this repo's
 * checks on this repo's PR would answer a question nobody asked and hide why the run is stuck.
 *
 * The HEAD COMMIT is the one thing that genuinely differs per PR, so it is read from the gate's
 * per-repo `headShas` map when this report's repo has an entry there, falling back to the scalar
 * `headSha` (which is the own-service head — the first entry — by construction). Reporting the
 * own-service head on a peer's PR would name a commit that repo has never heard of.
 */
function composeCi(
  instance: ExecutionInstance,
  truncations: string[],
  repo: string | null,
): PrVerificationReport['ci'] {
  const step = findStep(
    instance,
    (s) => s.agentKind === CI_AGENT_KIND,
    (s) => s.gate != null,
  )
  if (!step) {
    return {
      status: 'absent',
      note: 'No CI gate in this pipeline — no continuous-integration verdict was captured.',
      failingChecks: [],
      fixerAttempts: 0,
    }
  }
  const gate = step.gate
  if (!gate) {
    return {
      status: 'absent',
      note: 'The CI gate has not run yet, so no verdict was captured.',
      failingChecks: [],
      fixerAttempts: 0,
    }
  }
  const failingChecks: PrReportCheck[] = cap(
    gate.failingChecks ?? [],
    'ci.failingChecks',
    truncations,
  ).map((check) => ({
    name: scrubbed(check.name),
    conclusion: scrub(check.conclusion),
    url: check.url ?? null,
    repo: check.repo ?? null,
  }))
  return {
    status: 'reported',
    verdict: gate.lastVerdict ?? null,
    headSha: (repo ? gate.headShas?.[repo] : null) ?? gate.headSha ?? null,
    failingChecks,
    fixerAttempts: gate.attempts,
    maxFixerAttempts: gate.maxAttempts,
  }
}

function composeTests(
  instance: ExecutionInstance,
  truncations: string[],
): PrVerificationReport['tests'] {
  const step = findStep(
    instance,
    (s) => isTesterKind(s.agentKind),
    (s) => s.test?.lastReport != null,
  )
  if (!step) {
    return {
      status: 'absent',
      note: 'No tester step in this pipeline — no test run was performed by the platform.',
      tested: [],
      outcomes: [],
      concerns: [],
      fixerAttempts: 0,
    }
  }
  const report: TestReport | null | undefined = step.test?.lastReport
  if (!report) {
    return {
      status: 'absent',
      note: 'The tester step produced no report (it did not run to completion).',
      tested: [],
      outcomes: [],
      concerns: [],
      fixerAttempts: step.test?.attempts ?? 0,
    }
  }
  return {
    status: 'reported',
    greenlight: report.greenlight,
    summary: scrubbed(report.summary),
    environment: report.environment ?? null,
    tested: cap(report.tested, 'tests.tested', truncations).map(scrubbed),
    outcomes: cap(report.outcomes, 'tests.outcomes', truncations).map((o) => ({
      name: scrubbed(o.name),
      status: o.status,
      detail: scrub(o.detail),
    })),
    concerns: cap(report.concerns, 'tests.concerns', truncations).map((c) => ({
      title: scrubbed(c.title),
      severity: c.severity,
    })),
    fixerAttempts: step.test?.attempts ?? 0,
    maxFixerAttempts: step.test?.maxAttempts ?? null,
  }
}

/**
 * The merger's structured verdict. `step.custom` carries the engine's {@link MergeDecision}
 * once the merge resolver has run, and the agent's raw {@link MergeAssessment} in the window
 * before that — both are read, so a report composed at either moment is truthful.
 */
function composeMerge(instance: ExecutionInstance): PrVerificationReport['merge'] {
  const step = findStep(
    instance,
    (s) => s.agentKind === MERGER_AGENT_KIND,
    (s) => s.custom != null,
  )
  if (!step) {
    return {
      status: 'absent',
      note: 'No merger step in this pipeline — the merge decision is a human one.',
    }
  }
  const custom = step.custom as Partial<MergeDecision> & Partial<MergeAssessment>
  if (!settled(step) || !custom) {
    return { status: 'absent', note: 'The merger step has not produced an assessment yet.' }
  }
  const assessment: MergeAssessment | null =
    custom.assessment ??
    (typeof custom.complexity === 'number' &&
    typeof custom.risk === 'number' &&
    typeof custom.impact === 'number'
      ? {
          complexity: custom.complexity,
          risk: custom.risk,
          impact: custom.impact,
          rationale: custom.rationale ?? '',
        }
      : null)
  if (!assessment && !custom.outcome) {
    return { status: 'absent', note: 'The merger step produced no parseable assessment.' }
  }
  return {
    status: 'reported',
    assessment: assessment
      ? { ...assessment, rationale: scrubbed(assessment.rationale) }
      : assessment,
    outcome: custom.outcome ?? null,
    reason: custom.reason ?? null,
    presetName: custom.thresholds?.presetName ?? null,
  }
}

/**
 * Whether a row is a REGRESSION: behaviour the spec records as `established` — observed to hold
 * on some earlier run, which is the only thing that makes it standing behaviour — that this run's
 * Tester observed to FAIL.
 *
 * This is the one derived fact the implementation-state axis exists to make computable. Every
 * other consumer of the axis (the build prompt's two headings, the tester prompt's rule, the
 * `@aspirational` Gherkin tag) states the distinction in prose to a MODEL; nothing computed it
 * for a human. A `not_met` against an `aspirational` requirement is in-flight work; a `not_met`
 * against an `established` one is the service losing behaviour it had. Left uncomputed, the two
 * arrive at a reviewer as the same `not met` cell.
 */
function isRegression(row: PrReportRequirement): boolean {
  return row.state === 'established' && row.verdict === 'not_met'
}

/**
 * Cap the requirement table by SEVERITY FIRST, so a regression is the last thing dropped.
 *
 * The generic {@link cap} keeps a PREFIX, and these rows are emitted in spec order (module →
 * group → requirement). So on a large spec the single row a reviewer must not miss is dropped
 * precisely because of where its feature sorts — a silently-clean-looking table, which is the
 * failure this whole report exists to remove. Regressions are therefore selected first, the
 * remaining budget is filled in spec order, and the selection is restored to spec order so the
 * table still reads by feature rather than by severity.
 *
 * Priority is not a GUARANTEE: a spec with more regressions than the row budget still loses
 * some, and the note must not claim otherwise. It reports how many of them actually fit, since
 * a note that overstates what survived is the same false reassurance as no note at all. When
 * there are no regressions the selection IS the plain prefix, so it carries no extra clause.
 */
function selectRequirementEntries(
  rows: readonly PrReportRequirement[],
  truncations: string[],
): PrReportRequirement[] {
  const { items, dropped } = hostMarkdown.capList(rows)
  if (dropped === 0) return items

  const budget = items.length
  const kept = new Set<number>()
  for (const [i, row] of rows.entries()) {
    if (kept.size >= budget) break
    if (isRegression(row)) kept.add(i)
  }
  const keptRegressions = kept.size
  const totalRegressions = rows.filter(isRegression).length
  for (let i = 0; i < rows.length && kept.size < budget; i += 1) {
    if (!kept.has(i)) kept.add(i)
  }
  const detail =
    totalRegressions === 0
      ? undefined
      : keptRegressions === totalRegressions
        ? `not the first ${budget}: every regression kept`
        : `not the first ${budget}: only ${keptRegressions} of ${totalRegressions} regressions fit`
  truncations.push(truncationNote('requirements.entries', kept.size, rows.length, detail))
  return rows.filter((_, i) => kept.has(i))
}

/**
 * Compose the REQUIREMENT → EVIDENCE section: every requirement in the service's in-repo
 * `spec/`, paired with the Tester's verdict on it.
 *
 * The join is by the spec's OWN requirement id — the id the Gherkin render stamps above each
 * scenario and the Tester echoes back — so there is exactly one id space between the spec, the
 * tester and this report.
 *
 * A requirement the Tester said nothing about is `not_covered`, NOT `not_met`: silence means
 * nobody looked, and rendering that as a failure would make every unrelated PR look like it
 * broke the service. `not_covered` against an `aspirational` requirement is the expected
 * reading (it is not built yet), which is why the state travels with the verdict rather than
 * being left for the reader to guess.
 *
 * `spec` is null when it could not be read at all (no VCS wired, no repo resolved, a transport
 * failure) — distinct from a spec that IS readable but records no requirements. Both produce an
 * `absent` section, with notes that say which.
 *
 * Unlike the single-step `tests` section this reads EVERY tester step, because promotion does:
 * a pipeline carrying both `tester-api` and `tester-ui` promotes off both kinds' verdicts, so a
 * report joining only the last of them would show `not checked` against requirements the spec
 * already records as `established`. The contract's two consumers have to agree.
 */
function composeRequirements(
  instance: ExecutionInstance,
  spec: SpecDoc | null | undefined,
  truncations: string[],
): PrVerificationReport['requirements'] {
  const empty = { entries: [], met: 0, notMet: 0, notCovered: 0, regressions: 0, total: 0 }
  const testerSteps = instance.steps.filter((s) => isTesterKind(s.agentKind))
  if (testerSteps.length === 0) {
    return {
      status: 'absent',
      note:
        'No tester step in this pipeline — the acceptance criteria recorded in `spec/` were ' +
        'not verified by the platform on this run.',
      ...empty,
    }
  }
  const reports = testerSteps.map((s) => s.test?.lastReport).filter((r) => r != null)
  if (reports.length === 0) {
    return {
      status: 'absent',
      note: 'The tester step produced no report, so no requirement was ruled on.',
      ...empty,
    }
  }
  if (!spec) {
    return {
      status: 'absent',
      note:
        'The service specification under `spec/` could not be read for this run, so the ' +
        'tester’s verdicts could not be matched to requirements.',
      ...empty,
    }
  }

  // Index the verdicts by requirement id, across every tester step in pipeline order. A
  // duplicate id keeps the FIRST verdict — whether it repeats within one report or across two
  // testers — because last-wins would let a trailing `not_covered` quietly erase a real
  // observation, which is the one thing this section exists to prevent.
  const verdicts = new Map<string, RequirementVerdict>()
  for (const report of reports) {
    for (const verdict of report.requirementVerdicts ?? []) {
      if (!verdicts.has(verdict.requirementId)) verdicts.set(verdict.requirementId, verdict)
    }
  }

  const rows: PrReportRequirement[] = []
  for (const module of spec.modules ?? []) {
    for (const group of module.groups ?? []) {
      for (const req of group.requirements ?? []) {
        const verdict = verdicts.get(req.id)
        rows.push({
          id: req.id,
          title: scrubbed(req.title),
          module: scrubbed(module.name),
          group: scrubbed(group.name),
          priority: req.priority,
          state: req.state ?? 'aspirational',
          verdict: verdict?.status ?? 'not_covered',
          detail: verdictDetail(verdict?.detail),
          criteriaCount: (req.acceptance ?? []).length,
        })
      }
    }
  }
  if (rows.length === 0) {
    return {
      status: 'absent',
      note:
        'No acceptance criteria are recorded in `spec/` for this service, so there was ' +
        'nothing for the tester to rule on.',
      ...empty,
    }
  }

  // Counts are computed over EVERY row, before the cap — so a capped table still reports the
  // true totals and the `truncations` note says how much of the table was shown.
  const count = (status: PrReportRequirement['verdict']) =>
    rows.filter((r) => r.verdict === status).length
  return {
    status: 'reported',
    entries: selectRequirementEntries(rows, truncations),
    met: count('met'),
    notMet: count('not_met'),
    notCovered: count('not_covered'),
    regressions: rows.filter(isRegression).length,
    total: rows.length,
  }
}

/**
 * Compose the JUDGE section: every step carrying judge state, in pipeline order. Unlike the
 * single-step sections this reports ALL of them — a pipeline may place several rubrics, and
 * "which rubric said what" is the whole content of the section.
 *
 * A pipeline with no judge step reports `absent` with a note, exactly like every other section:
 * a silently missing section reads like a clean one, which is the false reassurance the whole
 * report exists to remove. A judge that PASSED is still reported — a reviewer wants to see that
 * the rubric ran and what it still noted, not just the ones that stopped the run.
 */
function composeJudges(
  instance: ExecutionInstance,
  truncations: string[],
): PrVerificationReport['judges'] {
  const steps = instance.steps.filter((s) => s.judge != null)
  if (steps.length === 0) {
    return { status: 'absent', note: 'No rubric review step in this pipeline.', verdicts: [] }
  }
  const verdicts = cap(steps, 'judges.verdicts', truncations).map((step) => {
    const judge = step.judge!
    return {
      stepKind: step.agentKind,
      rubricName: judge.rubricName ?? null,
      rubricOverridden: judge.rubricOverridden ?? false,
      score: judge.verdict?.score ?? null,
      threshold: judge.threshold ?? null,
      disposition: judge.disposition ?? null,
      // `note` explains a SKIPPED or degraded judge ("no assessment model configured", "no
      // preceding step to bounce to"); without it a pass-through judge would render as a blank
      // row that reads like a clean verdict.
      summary: scrubbed(judge.verdict?.summary ?? judge.note ?? ''),
      findings: cap(
        judge.verdict?.findings ?? [],
        `judges.${step.agentKind}.findings`,
        truncations,
      ).map((f) => ({
        ...f,
        title: scrubbed(f.title),
        ...(f.detail ? { detail: scrubbed(f.detail) } : {}),
      })),
      bounces: judge.bounces ?? 0,
      maxBounces: judge.maxBounces ?? 0,
      model: judge.model ?? null,
      // Carried only when the registration named a model: a rubric authored for one model and
      // scored by another is a fact about the verdict, not about the deployment's settings page.
      ...(judge.modelPin ? { modelPin: judge.modelPin } : {}),
    }
  })
  return { status: 'reported', verdicts }
}

/** Compose the report from a run's in-memory state plus the few resolved inputs. */
export function composePrVerificationReport(
  instance: ExecutionInstance,
  inputs: PrReportInputs,
): PrVerificationReport {
  const truncations: string[] = []
  // The two captured-output sections share the spine's list cap and add a char cap of their own,
  // both logging into the ONE `truncations` array a reader learns to read.
  const commandCaps = {
    cap: <T>(items: readonly T[], label: string): T[] => cap(items, label, truncations),
    output: makeOutputCapper(truncations),
  }
  const steps = instance.steps.map((step, index) => ({
    index,
    agentKind: step.agentKind,
    state: step.state,
    model: step.model ?? null,
  }))
  const scope = inputs.scope ?? { role: 'own' as const, frameId: null, ownPullRequest: null }
  const peer = isPeer(scope)
  return {
    version: PR_VERIFICATION_REPORT_VERSION,
    generatedAt: inputs.now,
    scope,
    run: {
      executionId: instance.id,
      blockId: instance.blockId,
      blockTitle: scrubbed(inputs.block.title),
      pipelineId: instance.pipelineId,
      pipelineName: scrubbed(instance.pipelineName),
      repo: inputs.repo ?? null,
      provider: inputs.provider ?? null,
      startedAt: instance.createdAt ?? null,
      steps: cap(steps, 'run.steps', truncations),
      issues: cap(inputs.issues, 'run.issues', truncations).map((issue) => ({
        ...issue,
        title: scrubbed(issue.title),
      })),
    },
    // The CI gate, the tester, the judges, the environments and the merge sequence are all
    // RUN-scoped: the gate reduces every repo's checks to one verdict that blocks every PR the
    // run opened, the tester ran once, and the merger merges the whole set (peers first, own
    // last). So they are reported identically on every PR — a peer reviewer needs to see that
    // the merge is blocked by another repo's red check, not a blank where the reason was.
    ci: composeCi(instance, truncations, inputs.repo ?? null),
    validation: peer
      ? {
          status: 'absent',
          note: ownServiceOnly('pre-PR validation', scope),
          attempts: 0,
          commands: [],
        }
      : composeValidation(instance, commandCaps),
    reproduction: peer
      ? {
          status: 'absent',
          note: ownServiceOnly('the bugfix reproduction proof', scope),
          testPaths: [],
          attempts: 0,
        }
      : composeReproduction(instance, commandCaps),
    tests: composeTests(instance, truncations),
    requirements: peer
      ? {
          status: 'absent',
          note: ownServiceOnly('the requirement → evidence join', scope),
          entries: [],
          met: 0,
          notMet: 0,
          notCovered: 0,
          regressions: 0,
          total: 0,
        }
      : composeRequirements(instance, inputs.spec, truncations),
    environments: composeEnvironments(instance, inputs.environments, (items, label) =>
      cap(items, label, truncations),
    ),
    merge: composeMerge(instance),
    judges: composeJudges(instance, truncations),
    observability: {
      runUrl: inputs.runUrl,
      trajectoryUrl: inputs.trajectoryUrl,
      reportUrl: inputs.reportUrl,
    },
    truncations,
  }
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/** A 0..1 score as a rounded percentage, matching how the merge notifications phrase them. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

// Interpolation of untrusted text goes through `cell` / `inline` / `prose`
// (kernel's `hostMarkdown` boundary) — never a bare template hole. See that module's header for what a
// PR body does to raw text.

function renderCi(ci: PrVerificationReport['ci']): string[] {
  const out = ['### Continuous integration', '']
  if (ci.status === 'absent') return [...out, absentNote(ci.note), '']
  const verdict =
    ci.verdict === 'pass'
      ? '✅ green'
      : ci.verdict === 'fail'
        ? '❌ failing'
        : ci.verdict === 'pending'
          ? '⏳ still running'
          : 'not reported'
  out.push(`**Verdict:** ${verdict}` + (ci.headSha ? ` (head \`${ci.headSha}\`)` : ''))
  out.push(
    `**Fixer attempts:** ${ci.fixerAttempts}` +
      (ci.maxFixerAttempts != null ? ` of ${ci.maxFixerAttempts}` : ''),
  )
  if (ci.failingChecks.length) {
    // The repo column appears only when the gate tagged a check with one, which it does exactly
    // on a MULTI-REPO run. Without it a cross-service reviewer reads a list of red check names
    // with no way to tell which repo is actually broken — and on a peer's PR, no way to tell
    // that the red one isn't theirs.
    const multiRepo = ci.failingChecks.some((check) => check.repo)
    out.push(
      '',
      multiRepo ? '| Check | Repo | Conclusion |' : '| Check | Conclusion |',
      multiRepo ? '| --- | --- | --- |' : '| --- | --- |',
    )
    for (const check of ci.failingChecks) {
      const name = hostMarkdown.cellLink(check.name, check.url)
      const conclusion = hostMarkdown.cell(check.conclusion ?? 'unknown')
      out.push(
        multiRepo
          ? `| ${name} | ${hostMarkdown.cell(check.repo ?? '—')} | ${conclusion} |`
          : `| ${name} | ${conclusion} |`,
      )
    }
  }
  return [...out, '']
}

function renderTests(tests: PrVerificationReport['tests']): string[] {
  const out = ['### Test verification', '']
  if (tests.status === 'absent') return [...out, absentNote(tests.note), '']
  out.push(`**Greenlight:** ${tests.greenlight ? '✅ yes' : '❌ withheld'}`)
  if (tests.environment) out.push(`**Environment:** ${tests.environment}`)
  out.push(
    `**Fixer attempts:** ${tests.fixerAttempts}` +
      (tests.maxFixerAttempts != null ? ` of ${tests.maxFixerAttempts}` : ''),
  )
  if (tests.summary) out.push('', hostMarkdown.prose(tests.summary))
  if (tests.tested.length) {
    out.push('', '**Exercised:**', ...tests.tested.map((t) => `- ${t}`))
  }
  if (tests.outcomes.length) {
    out.push('', '| Area | Result | Detail |', '| --- | --- | --- |')
    for (const outcome of tests.outcomes) {
      out.push(
        `| ${hostMarkdown.cell(outcome.name)} | ${hostMarkdown.cell(outcome.status)} | ${hostMarkdown.cell(outcome.detail ?? '')} |`,
      )
    }
  }
  if (tests.concerns.length) {
    out.push(
      '',
      '**Outstanding concerns:**',
      ...tests.concerns.map((c) => `- \`${c.severity}\` ${c.title}`),
    )
  }
  return [...out, '']
}

/**
 * Render the requirement → evidence table. Every hole goes through `hostMarkdown.cell` —
 * requirement titles, module/group names and the tester's `detail` are all model-authored text
 * landing in a host-parsed, often public PR body.
 *
 * The three verdicts are given visibly DIFFERENT markers on purpose: "we didn't check" and
 * "it's broken" reading the same is the exact failure this section exists to remove. A
 * REGRESSION — a failing verdict against a requirement the spec records as `established` —
 * gets a fourth marker for the same reason one axis over: "this is not built yet" and "this used
 * to work" are the two readings of `not met`, and only one of them should stop a REVIEWER. The
 * report marks it; it does not gate on it (gating lives in the gate/judge registries).
 */
function renderRequirements(reqs: PrVerificationReport['requirements']): string[] {
  const out = ['### Requirement verification', '']
  if (reqs.status === 'absent') return [...out, absentNote(reqs.note), '']
  // The regression count LEADS when there is one. It is a subset of `not met`, so it is stated
  // as its own line rather than as a fourth tally that would not add up to the total.
  if (reqs.regressions > 0) {
    // The count is over the WHOLE spec while the table is capped, so on a spec with more
    // regressions than the row budget the call-out would send a reader to a table that cannot
    // show all of them. It says so rather than letting the reader count the rows and conclude
    // the difference was never broken.
    const shown = reqs.entries.filter(isRegression).length
    out.push(
      `**🔴 ${reqs.regressions} regression${reqs.regressions === 1 ? '' : 's'}** — ` +
        `${reqs.regressions === 1 ? 'a requirement' : 'requirements'} this service was ` +
        `OBSERVED to honour, now failing. Established behaviour breaking is not in-progress ` +
        `work; check ${reqs.regressions === 1 ? 'it' : 'them'} before merging.` +
        (shown < reqs.regressions
          ? ` The table below shows ${shown} of them — the rest were cut for length.`
          : ''),
      '',
    )
  }
  out.push(
    `**${reqs.met} met** · **${reqs.notMet} not met** · **${reqs.notCovered} not checked** ` +
      `(of ${reqs.total} requirement${reqs.total === 1 ? '' : 's'} in \`spec/\`)`,
    '',
    '| Requirement | Feature | State | Verdict | Observed |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const entry of reqs.entries) {
    const regression = isRegression(entry)
    const verdict =
      entry.verdict === 'met'
        ? '✅ met'
        : entry.verdict === 'not_met'
          ? regression
            ? '🔴 **regression**'
            : '❌ not met'
          : '➖ not checked'
    // An `aspirational` requirement is agreed-but-not-built, so say so inline rather than
    // leaving a reader to read `not checked` against it as a coverage gap.
    const state = entry.state === 'established' ? 'established' : 'aspirational'
    const title = `${hostMarkdown.cell(entry.title)} \`${hostMarkdown.cell(entry.id)}\``
    const feature = hostMarkdown.cell(`${entry.module} › ${entry.group}`)
    out.push(
      `| ${title} | ${feature} | ${state} | ${verdict} | ${hostMarkdown.cell(entry.detail ?? '')} |`,
    )
  }
  out.push(
    '',
    '_`established` = observed to hold on some run; `aspirational` = agreed but not yet built,',
    'so `not checked` against one is expected and a failure against one is unfinished work, not',
    'a break. A failure against an `established` requirement is a 🔴 regression. The acceptance',
    'criteria themselves live in `spec/` in this repository._',
    '',
  )
  return out
}

function renderMerge(merge: PrVerificationReport['merge']): string[] {
  const out = ['### Merge assessment', '']
  if (merge.status === 'absent') return [...out, absentNote(merge.note), '']
  if (merge.assessment) {
    out.push(
      `**Complexity** ${pct(merge.assessment.complexity)} · ` +
        `**Risk** ${pct(merge.assessment.risk)} · ` +
        `**Impact** ${pct(merge.assessment.impact)}` +
        (merge.presetName ? ` (preset: ${merge.presetName})` : ''),
    )
    if (merge.assessment.rationale) out.push('', hostMarkdown.prose(merge.assessment.rationale))
  }
  if (merge.outcome) {
    out.push(
      '',
      `**Engine decision:** ${merge.outcome}` + (merge.reason ? ` — ${merge.reason}` : ''),
    )
  }
  return [...out, '']
}

/**
 * The registration's model pin, rendered beside the model that actually ran. Only the case a
 * reviewer must act on gets words: a pin this deployment could not serve means the rubric was
 * scored by a model its author did not choose, which the model name alone cannot show. An
 * `applied` pin adds nothing the model name doesn't already say, and `overridden` is the normal
 * outcome of a task or workspace making a more specific choice.
 */
function renderJudgeModelPin(pin: PrReportJudge['modelPin']): string {
  if (pin?.status !== 'unavailable') return ''
  return ` · ⚠️ rubric pinned \`${hostMarkdown.cell(pin.requested)}\`, unavailable in this deployment`
}

function renderJudges(judges: PrVerificationReport['judges']): string[] {
  const out = ['### Rubric reviews', '']
  if (judges.status === 'absent') return [...out, absentNote(judges.note), '']
  for (const verdict of judges.verdicts) {
    const name = hostMarkdown.inline(verdict.rubricName ?? verdict.stepKind)
    const score =
      verdict.score != null
        ? `${pct(verdict.score)}${verdict.threshold != null ? ` (threshold ${pct(verdict.threshold)})` : ''}`
        : 'not scored'
    out.push(
      `**${name}** — ${score}` +
        (verdict.disposition ? ` · **${verdict.disposition}**` : '') +
        (verdict.rubricOverridden ? ' · workspace rubric' : '') +
        (verdict.maxBounces > 0 ? ` · rework ${verdict.bounces}/${verdict.maxBounces}` : '') +
        (verdict.model ? ` · \`${hostMarkdown.cell(verdict.model)}\`` : '') +
        renderJudgeModelPin(verdict.modelPin),
    )
    if (verdict.summary) out.push('', hostMarkdown.prose(verdict.summary))
    if (verdict.findings.length) {
      out.push('', '| Severity | Finding | Where |', '| --- | --- | --- |')
      for (const f of verdict.findings) {
        const detail = f.detail ? ` — ${f.detail}` : ''
        out.push(
          `| ${hostMarkdown.cell(f.severity)} | ${hostMarkdown.cell(`${f.title}${detail}`)} | ${f.where ? hostMarkdown.cell(f.where) : '—'} |`,
        )
      }
    }
    out.push('')
  }
  return out
}

function renderRun(
  run: PrVerificationReport['run'],
  observability: PrVerificationReport['observability'],
): string[] {
  const out = [
    '### Run',
    '',
    `**Task:** ${hostMarkdown.inline(run.blockTitle)} (\`${run.blockId}\`)`,
    `**Pipeline:** ${hostMarkdown.inline(run.pipelineName)} (\`${run.pipelineId}\`)`,
    `**Execution:** \`${run.executionId}\``,
  ]
  if (run.repo) out.push(`**Repository:** ${run.repo}${run.provider ? ` (${run.provider})` : ''}`)
  if (run.issues.length) {
    out.push(
      `**Tracker issues:** ${run.issues.map((i) => `[${hostMarkdown.inline(i.title)}](${i.url})`).join(', ')}`,
    )
  }
  if (observability.runUrl) {
    out.push(`**Observability:** [Model activity / Provided context](${observability.runUrl})`)
  }
  // The two machine links are rendered in the PROSE as well as carried in the JSON block, and
  // that is the point of the feature rather than a duplication: the reader who needs to check a
  // claim in this report is often a person, and a trajectory nobody can find is not an audit
  // trail. Both endpoints are key-authenticated, so a reader without a credential gets a 401,
  // the same honest refusal the app link beside them produces.
  if (observability.trajectoryUrl) {
    out.push(`**Trajectory (API):** [Every tool call, in order](${observability.trajectoryUrl})`)
  }
  if (observability.reportUrl) {
    out.push(`**This report (API):** [Live JSON](${observability.reportUrl})`)
  }
  out.push('', '| # | Step | State | Model |', '| --- | --- | --- | --- |')
  for (const step of run.steps) {
    out.push(
      `| ${step.index + 1} | ${hostMarkdown.cell(step.agentKind)} | ${hostMarkdown.cell(step.state)} | ${step.model ? hostMarkdown.cell(step.model) : '—'} |`,
    )
  }
  return [...out, '']
}

/** Name whatever the report had to leave out, so a capped list never reads as a complete one. */
function renderTruncations(truncations: readonly string[]): string[] {
  if (!truncations.length) return []
  return [
    '### Omitted for length',
    '',
    ...truncations.map((note) => `- ${hostMarkdown.cell(note)}`),
    '',
    '_The full values are in the run’s observability panel._',
    '',
  ]
}

/**
 * The one-line banner a PEER repo's copy of the report opens with.
 *
 * A reviewer on a connected service's PR is looking at one repo of a change that spans several,
 * and every downstream section reads differently once they know that: the CI verdict covers
 * repos whose checks are not on this PR, the merge happens as a set, and three sections are
 * withheld as own-service-only. Saying so once at the top is what keeps those from reading as
 * gaps. An own-service report (every single-repo run) renders nothing, so the ordinary case is
 * byte-for-byte what it was.
 */
function renderScope(scope: PrVerificationReport['scope']): string[] {
  if (scope?.role !== 'peer') return []
  const own = scope.ownPullRequest
  // The URL goes through the link boundary, not a template hole: a peer PR's URL is a string
  // the harness reported, and an unusable one renders as the plain `#12` a reader can still act
  // on rather than spilling out of the link syntax.
  const pointer = own
    ? `The task's own service is ${hostMarkdown.inline(own.repo)}` +
      ` (${hostMarkdown.link(`#${own.number}`, own.url)}).`
    : "The task's own service has no pull request open yet."
  return [
    `> **This is a connected service's pull request.** This change spans several repositories; ` +
      `the run's evidence below covers all of them. ${pointer} Pre-PR validation, the ` +
      `reproduction proof and the requirement check are reported there, since they run against ` +
      `that service.`,
    '',
  ]
}

/**
 * Render the report as the managed PR-body section: human-readable markdown followed by a
 * fenced JSON block carrying the exact {@link PrVerificationReport} shape, so external
 * tooling can ingest it without scraping prose. The caller splices the result into the PR
 * body between the kernel's markers — this function emits the section CONTENTS only.
 */
export function renderPrVerificationReport(report: PrVerificationReport): string {
  const body = [
    '## 🐈 Verification report',
    '',
    '_Maintained by cat-factory. These are captured facts from the run that produced this PR,',
    "not the agent's own claims. It is rewritten in place as the run progresses._",
    '',
    ...renderScope(report.scope),
    ...renderRun(report.run, report.observability),
    ...renderCi(report.ci),
    // The two CAPTURED-OUTPUT sections sit beside CI rather than at the end: they answer the same
    // question a reviewer asks first ("does it work?"), and unlike CI they are the platform's own
    // run of the commands on the exact tree that was pushed.
    ...renderValidation(report.validation),
    ...renderReproduction(report.reproduction),
    ...renderTests(report.tests),
    ...renderRequirements(report.requirements),
    ...renderEnvironments(report.environments),
    ...renderJudges(report.judges),
    ...renderMerge(report.merge),
    ...renderTruncations(report.truncations),
  ].join('\n')

  const json = [
    '<details><summary>Machine-readable report (JSON)</summary>',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
    '</details>',
  ].join('\n')

  // The machine-readable half is the droppable one: a reviewer reads the prose above, while the
  // JSON block is bulk an external consumer can re-fetch from the API. So when the section would
  // blow the host's body limit — only reachable with pathological data, since every field is
  // capped at compose time — the JSON goes and a note SAYS it went. Failing the publish instead
  // would leave the PR with no report at all, and silently forever (publishing is best-effort
  // by design), which is the outcome this budget exists to avoid.
  const full = `${body}\n${json}`
  if (full.length <= hostMarkdown.MAX_SECTION_CHARS) return full
  const dropped = `${body}\n_The machine-readable JSON block was omitted: this report exceeds the ${hostMarkdown.MAX_SECTION_CHARS}-character budget for a pull-request description._`
  if (dropped.length <= hostMarkdown.MAX_SECTION_CHARS) return dropped
  // Absolute backstop: the prose alone is over budget. Cut it rather than let the host reject
  // the whole write — then drop whatever fenced block the cut landed INSIDE. The captured-output
  // sections put real fences in the prose half (a validation log, a reproduction tree's log), and
  // a blind slice through one leaves it unclosed, which swallows the truncation note and the
  // section's own `:end` marker into a code block. `balanceFences` is the wrong tool here: it
  // ADDS a closing fence to text that is already over the limit, by an amount sized to the
  // longest backtick run in the block. Dropping only ever removes, so it fits by construction,
  // and the half a cut leaves behind is the HEAD of a log whose failure is reported at its tail.
  const room = hostMarkdown.MAX_SECTION_CHARS - TRUNCATED_SECTION_NOTE.length
  return `${hostMarkdown.dropOpenFence(dropped.slice(0, room))}${TRUNCATED_SECTION_NOTE}`
}

/** Closes a section that had to be cut at {@link hostMarkdown.MAX_SECTION_CHARS}. */
const TRUNCATED_SECTION_NOTE = '\n\n_… report truncated to fit the pull-request body limit._'
