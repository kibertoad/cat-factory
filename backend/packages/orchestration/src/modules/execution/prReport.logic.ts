import type {
  Block,
  ExecutionInstance,
  MergeAssessment,
  MergeDecision,
  PipelineStep,
  PrReportCheck,
  PrReportEnvironment,
  PrReportIssue,
  PrReportRequirement,
  PrVerificationReport,
  RequirementVerdict,
  SpecDoc,
  TestReport,
} from '@cat-factory/kernel'
import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'
import { PR_VERIFICATION_REPORT_VERSION } from '@cat-factory/contracts'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'
import { CI_AGENT_KIND, MERGER_AGENT_KIND, isTesterKind } from './ci.logic.js'

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
 * Cap a list, recording what was dropped in the report's own `truncations` log.
 *
 * A silently shortened list is the same failure this feature exists to remove: 50 of 112
 * failing checks reads exactly like "112 checks, 50 failed". The report SAYS what it left out.
 */
function cap<T>(items: readonly T[], label: string, truncations: string[]): T[] {
  const { items: kept, dropped } = hostMarkdown.capList(items)
  if (dropped > 0) truncations.push(`${label}: showing ${kept.length} of ${items.length}`)
  return kept
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
   * The service's in-repo `spec/` tree, reassembled from the run's branch, for the
   * requirement → evidence join. `null`/absent when it could not be read at all (no VCS
   * wired, no repo resolved, a transport failure) — which the section reports distinctly from
   * a spec that IS readable but records no requirements.
   */
  spec?: SpecDoc | null
  /** Epoch ms stamped as the report's `generatedAt`. */
  now: number
}

/**
 * The step a section should report on: the LAST matching step that carries evidence, else the
 * first matching step (so a pipeline that has the step but hasn't reached it still gets the
 * "not run yet" note rather than nothing).
 *
 * Last-with-evidence, not first-match: a pipeline may legitimately carry the same kind twice —
 * a `ci` gate after the coder and another after the tester, say — and the later run is the one
 * that describes the PR head as it stands now. Reporting the first would pin the section to a
 * verdict two steps of work out of date.
 */
function findStep(
  instance: ExecutionInstance,
  matches: (step: PipelineStep) => boolean,
  hasEvidence: (step: PipelineStep) => boolean,
): PipelineStep | undefined {
  const matching = instance.steps.filter(matches)
  for (let i = matching.length - 1; i >= 0; i--) {
    if (hasEvidence(matching[i]!)) return matching[i]
  }
  return matching[0]
}

/** A step is "settled" once it finished — a pending step has no evidence to report yet. */
function settled(step: PipelineStep | undefined): boolean {
  return !!step && (step.state === 'done' || step.progress >= 1)
}

function composeCi(instance: ExecutionInstance, truncations: string[]): PrVerificationReport['ci'] {
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
    headSha: gate.headSha ?? null,
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
 * Whether the ephemeral environments a run stood up are gone again. Read off the live
 * per-step environment projections rather than the terminal `deployEnvs` outcomes, because
 * only the projection carries the CURRENT lifecycle state (`torn_down` / `expired`).
 */
function teardownState(
  instance: ExecutionInstance,
  entries: PrReportEnvironment[],
): PrVerificationReport['environments']['teardown'] {
  if (!entries.some((e) => e.status === 'ready')) return 'not_applicable'
  const live = instance.steps.some(
    (s) =>
      s.environment != null &&
      s.environment.status !== 'torn_down' &&
      s.environment.status !== 'expired' &&
      s.environment.status !== 'failed',
  )
  return live ? 'pending' : 'confirmed'
}

function composeEnvironments(
  instance: ExecutionInstance,
  truncations: string[],
): PrVerificationReport['environments'] {
  const step = findStep(
    instance,
    (s) => s.agentKind === DEPLOYER_AGENT_KIND,
    (s) => Object.keys(s.deployEnvs ?? {}).length > 0,
  )
  if (!step) {
    return {
      status: 'absent',
      note: 'No deployer step in this pipeline — no ephemeral environment was provisioned.',
      entries: [],
      teardown: 'not_applicable',
    }
  }
  const entries: PrReportEnvironment[] = cap(
    Object.entries(step.deployEnvs ?? {}),
    'environments.entries',
    truncations,
  ).map(([frameId, state]) => ({
    frameId,
    status: state.status,
    url: state.url ?? null,
    error: scrub(state.error),
  }))
  if (entries.length === 0) {
    return {
      status: 'absent',
      note: 'The deployer step recorded no environment outcomes (it did not run to completion).',
      entries: [],
      teardown: 'not_applicable',
    }
  }
  return { status: 'reported', entries, teardown: teardownState(instance, entries) }
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
 */
function composeRequirements(
  instance: ExecutionInstance,
  spec: SpecDoc | null | undefined,
  truncations: string[],
): PrVerificationReport['requirements'] {
  const empty = { entries: [], met: 0, notMet: 0, notCovered: 0, total: 0 }
  const testerStep = findStep(
    instance,
    (s) => isTesterKind(s.agentKind),
    (s) => s.test?.lastReport != null,
  )
  if (!testerStep) {
    return {
      status: 'absent',
      note:
        'No tester step in this pipeline — the acceptance criteria recorded in `spec/` were ' +
        'not verified by the platform on this run.',
      ...empty,
    }
  }
  const report = testerStep.test?.lastReport
  if (!report) {
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

  // Index the tester's verdicts by requirement id. A duplicate id keeps the FIRST verdict:
  // the alternative (last-wins) would let a trailing `not_covered` quietly erase a real
  // observation earlier in the same list.
  const verdicts = new Map<string, RequirementVerdict>()
  for (const verdict of report.requirementVerdicts ?? []) {
    if (!verdicts.has(verdict.requirementId)) verdicts.set(verdict.requirementId, verdict)
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
          detail: verdict?.detail ? scrubbed(verdict.detail) : null,
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
    entries: cap(rows, 'requirements.entries', truncations),
    met: count('met'),
    notMet: count('not_met'),
    notCovered: count('not_covered'),
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
  const steps = instance.steps.map((step, index) => ({
    index,
    agentKind: step.agentKind,
    state: step.state,
    model: step.model ?? null,
  }))
  return {
    version: PR_VERIFICATION_REPORT_VERSION,
    generatedAt: inputs.now,
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
    ci: composeCi(instance, truncations),
    tests: composeTests(instance, truncations),
    requirements: composeRequirements(instance, inputs.spec, truncations),
    environments: composeEnvironments(instance, truncations),
    merge: composeMerge(instance),
    judges: composeJudges(instance, truncations),
    observability: { runUrl: inputs.runUrl },
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
  if (ci.status === 'absent') return [...out, `_${ci.note}_`, '']
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
    out.push('', '| Check | Conclusion |', '| --- | --- |')
    for (const check of ci.failingChecks) {
      const name = check.url
        ? `[${hostMarkdown.cell(check.name)}](${check.url})`
        : hostMarkdown.cell(check.name)
      out.push(`| ${name} | ${hostMarkdown.cell(check.conclusion ?? 'unknown')} |`)
    }
  }
  return [...out, '']
}

function renderTests(tests: PrVerificationReport['tests']): string[] {
  const out = ['### Test verification', '']
  if (tests.status === 'absent') return [...out, `_${tests.note}_`, '']
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
 * "it's broken" reading the same is the exact failure this section exists to remove.
 */
function renderRequirements(reqs: PrVerificationReport['requirements']): string[] {
  const out = ['### Requirement verification', '']
  if (reqs.status === 'absent') return [...out, `_${reqs.note}_`, '']
  out.push(
    `**${reqs.met} met** · **${reqs.notMet} not met** · **${reqs.notCovered} not checked** ` +
      `(of ${reqs.total} requirement${reqs.total === 1 ? '' : 's'} in \`spec/\`)`,
    '',
    '| Requirement | Feature | State | Verdict | Observed |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const entry of reqs.entries) {
    const verdict =
      entry.verdict === 'met'
        ? '✅ met'
        : entry.verdict === 'not_met'
          ? '❌ not met'
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
    'so `not checked` against one is expected. The acceptance criteria themselves live in',
    '`spec/` in this repository._',
    '',
  )
  return out
}

function renderEnvironments(envs: PrVerificationReport['environments']): string[] {
  const out = ['### Ephemeral environment', '']
  if (envs.status === 'absent') return [...out, `_${envs.note}_`, '']
  out.push('| Service frame | State | URL | Error |', '| --- | --- | --- | --- |')
  for (const entry of envs.entries) {
    out.push(
      `| \`${hostMarkdown.cell(entry.frameId)}\` | ${entry.status} | ${hostMarkdown.cell(entry.url ?? '')} | ${hostMarkdown.cell(entry.error ?? '')} |`,
    )
  }
  const teardown =
    envs.teardown === 'confirmed'
      ? '✅ torn down'
      : envs.teardown === 'pending'
        ? '⏳ still live'
        : 'nothing to tear down'
  return [...out, '', `**Teardown:** ${teardown}`, '']
}

function renderMerge(merge: PrVerificationReport['merge']): string[] {
  const out = ['### Merge assessment', '']
  if (merge.status === 'absent') return [...out, `_${merge.note}_`, '']
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

function renderJudges(judges: PrVerificationReport['judges']): string[] {
  const out = ['### Rubric reviews', '']
  if (judges.status === 'absent') return [...out, `_${judges.note}_`, '']
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
        (verdict.model ? ` · \`${hostMarkdown.cell(verdict.model)}\`` : ''),
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

function renderRun(run: PrVerificationReport['run'], runUrl: string | null): string[] {
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
  if (runUrl) out.push(`**Observability:** [Model activity / Provided context](${runUrl})`)
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
    ...renderRun(report.run, report.observability.runUrl),
    ...renderCi(report.ci),
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
  // the whole write.
  return `${dropped.slice(0, hostMarkdown.MAX_SECTION_CHARS - TRUNCATED_SECTION_NOTE.length)}${TRUNCATED_SECTION_NOTE}`
}

/** Closes a section that had to be cut at {@link hostMarkdown.MAX_SECTION_CHARS}. */
const TRUNCATED_SECTION_NOTE = '\n\n_… report truncated to fit the pull-request body limit._'
