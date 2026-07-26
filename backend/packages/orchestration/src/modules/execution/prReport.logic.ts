import type {
  Block,
  ExecutionInstance,
  MergeAssessment,
  MergeDecision,
  PipelineStep,
  PrReportCheck,
  PrReportEnvironment,
  PrReportIssue,
  PrVerificationReport,
  TestReport,
} from '@cat-factory/kernel'
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
// ---------------------------------------------------------------------------

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
  /** Epoch ms stamped as the report's `generatedAt`. */
  now: number
}

/** The first step of `kind` that has any recorded state, else the first matching step. */
function findStep(
  instance: ExecutionInstance,
  matches: (step: PipelineStep) => boolean,
): PipelineStep | undefined {
  return instance.steps.find(matches)
}

/** A step is "settled" once it finished — a pending step has no evidence to report yet. */
function settled(step: PipelineStep | undefined): boolean {
  return !!step && (step.state === 'done' || step.progress >= 1)
}

function composeCi(instance: ExecutionInstance): PrVerificationReport['ci'] {
  const step = findStep(instance, (s) => s.agentKind === CI_AGENT_KIND)
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
  const failingChecks: PrReportCheck[] = (gate.failingChecks ?? []).map((check) => ({
    name: check.name,
    conclusion: check.conclusion,
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

function composeTests(instance: ExecutionInstance): PrVerificationReport['tests'] {
  const step = findStep(instance, (s) => isTesterKind(s.agentKind))
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
    summary: report.summary,
    environment: report.environment ?? null,
    tested: [...report.tested],
    outcomes: report.outcomes.map((o) => ({
      name: o.name,
      status: o.status,
      detail: o.detail ?? null,
    })),
    concerns: report.concerns.map((c) => ({ title: c.title, severity: c.severity })),
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

function composeEnvironments(instance: ExecutionInstance): PrVerificationReport['environments'] {
  const step = findStep(instance, (s) => s.agentKind === DEPLOYER_AGENT_KIND)
  if (!step) {
    return {
      status: 'absent',
      note: 'No deployer step in this pipeline — no ephemeral environment was provisioned.',
      entries: [],
      teardown: 'not_applicable',
    }
  }
  const entries: PrReportEnvironment[] = Object.entries(step.deployEnvs ?? {}).map(
    ([frameId, state]) => ({
      frameId,
      status: state.status,
      url: state.url ?? null,
      error: state.error ?? null,
    }),
  )
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
  const step = findStep(instance, (s) => s.agentKind === MERGER_AGENT_KIND)
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
    assessment,
    outcome: custom.outcome ?? null,
    reason: custom.reason ?? null,
    presetName: custom.thresholds?.presetName ?? null,
  }
}

/** Compose the report from a run's in-memory state plus the few resolved inputs. */
export function composePrVerificationReport(
  instance: ExecutionInstance,
  inputs: PrReportInputs,
): PrVerificationReport {
  return {
    version: PR_VERIFICATION_REPORT_VERSION,
    generatedAt: inputs.now,
    run: {
      executionId: instance.id,
      blockId: instance.blockId,
      blockTitle: inputs.block.title,
      pipelineId: instance.pipelineId,
      pipelineName: instance.pipelineName,
      repo: inputs.repo ?? null,
      provider: inputs.provider ?? null,
      startedAt: instance.createdAt ?? null,
      steps: instance.steps.map((step, index) => ({
        index,
        agentKind: step.agentKind,
        state: step.state,
        model: step.model ?? null,
      })),
      issues: inputs.issues,
    },
    ci: composeCi(instance),
    tests: composeTests(instance),
    environments: composeEnvironments(instance),
    merge: composeMerge(instance),
    observability: { runUrl: inputs.runUrl },
  }
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/** A 0..1 score as a rounded percentage, matching how the merge notifications phrase them. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

/** Escape a pipe so a value can't break out of a markdown table cell. */
function cell(value: string): string {
  return value.replaceAll('|', '\\|')
}

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
      const name = check.url ? `[${cell(check.name)}](${check.url})` : cell(check.name)
      out.push(`| ${name} | ${cell(check.conclusion ?? 'unknown')} |`)
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
  if (tests.summary) out.push('', tests.summary)
  if (tests.tested.length) {
    out.push('', '**Exercised:**', ...tests.tested.map((t) => `- ${t}`))
  }
  if (tests.outcomes.length) {
    out.push('', '| Area | Result | Detail |', '| --- | --- | --- |')
    for (const outcome of tests.outcomes) {
      out.push(
        `| ${cell(outcome.name)} | ${cell(outcome.status)} | ${cell(outcome.detail ?? '')} |`,
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

function renderEnvironments(envs: PrVerificationReport['environments']): string[] {
  const out = ['### Ephemeral environment', '']
  if (envs.status === 'absent') return [...out, `_${envs.note}_`, '']
  out.push('| Service frame | State | URL | Error |', '| --- | --- | --- | --- |')
  for (const entry of envs.entries) {
    out.push(
      `| \`${cell(entry.frameId)}\` | ${entry.status} | ${cell(entry.url ?? '')} | ${cell(entry.error ?? '')} |`,
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
    if (merge.assessment.rationale) out.push('', merge.assessment.rationale)
  }
  if (merge.outcome) {
    out.push(
      '',
      `**Engine decision:** ${merge.outcome}` + (merge.reason ? ` — ${merge.reason}` : ''),
    )
  }
  return [...out, '']
}

function renderRun(run: PrVerificationReport['run'], runUrl: string | null): string[] {
  const out = [
    '### Run',
    '',
    `**Task:** ${cell(run.blockTitle)} (\`${run.blockId}\`)`,
    `**Pipeline:** ${cell(run.pipelineName)} (\`${run.pipelineId}\`)`,
    `**Execution:** \`${run.executionId}\``,
  ]
  if (run.repo) out.push(`**Repository:** ${run.repo}${run.provider ? ` (${run.provider})` : ''}`)
  if (run.issues.length) {
    out.push(
      `**Tracker issues:** ${run.issues.map((i) => `[${cell(i.title)}](${i.url})`).join(', ')}`,
    )
  }
  if (runUrl) out.push(`**Observability:** [Model activity / Provided context](${runUrl})`)
  out.push('', '| # | Step | State | Model |', '| --- | --- | --- | --- |')
  for (const step of run.steps) {
    out.push(`| ${step.index + 1} | ${step.agentKind} | ${step.state} | ${step.model ?? '—'} |`)
  }
  return [...out, '']
}

/**
 * Render the report as the managed PR-body section: human-readable markdown followed by a
 * fenced JSON block carrying the exact {@link PrVerificationReport} shape, so external
 * tooling can ingest it without scraping prose. The caller splices the result into the PR
 * body between the kernel's markers — this function emits the section CONTENTS only.
 */
export function renderPrVerificationReport(report: PrVerificationReport): string {
  const lines = [
    '## 🐈 Verification report',
    '',
    '_Maintained by cat-factory. These are captured facts from the run that produced this PR,',
    "not the agent's own claims. It is rewritten in place as the run progresses._",
    '',
    ...renderRun(report.run, report.observability.runUrl),
    ...renderCi(report.ci),
    ...renderTests(report.tests),
    ...renderEnvironments(report.environments),
    ...renderMerge(report.merge),
    '<details><summary>Machine-readable report (JSON)</summary>',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
    '</details>',
  ]
  return lines.join('\n')
}
