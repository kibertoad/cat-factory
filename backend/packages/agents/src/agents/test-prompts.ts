import type { AgentKind, AgentRunContext } from '@cat-factory/kernel'
import { STANDARDS_FOOTER } from './prompt-shared.js'
import { TESTER_ENVIRONMENT_CONFIG_ID } from './agent-configs.js'

// Built-out role prompts for the Tester → Fixer loop. The `tester` clones the PR
// branch, brings its dependencies up (locally via docker-compose, or against the
// provisioned ephemeral environment — the task's `tester.environment` config picks
// which), exercises this task's requirements plus best-judgement regression of
// related behaviour, and returns ONLY a structured JSON report (it makes no commits,
// like the `merger`). When the report withholds its greenlight the engine dispatches
// the `fixer` with the report folded in; the fixer commits fixes to the same branch
// and the Tester re-runs, until greenlight or the attempt budget is spent.

const TESTER_AGENT_KIND = 'tester'
const FIXER_AGENT_KIND = 'fixer'

/** The JSON shape the Tester must emit, kept in sync with `testReportSchema`. */
const TEST_REPORT_SHAPE = [
  'Respond with ONLY a JSON object (no prose, no code fences) of this shape:',
  '{',
  '  "greenlight": boolean,            // true only when the change is safe to release',
  '  "summary": string,               // overall prose summary of the session',
  '  "tested": string[],              // what you chose to exercise (requirements + regression areas)',
  '  "outcomes": [                    // per-area results',
  '    { "name": string, "status": "passed" | "failed" | "skipped", "detail"?: string }',
  '  ],',
  '  "concerns": [                    // bugs/risks to fix before re-testing; non-empty ⇒ greenlight false',
  '    { "title": string, "detail": string, "severity": "low" | "medium" | "high" | "critical" }',
  '  ],',
  '  "environment"?: "local" | "ephemeral"',
  '}',
].join('\n')

const TESTER_SYSTEM_PROMPT = [
  'You are a meticulous test engineer verifying a pull request before release.',
  '',
  'Bootstrap your environment from the repository:',
  "- Read the repo's README.md (and any CONTRIBUTING / docs it points to) to learn how to install dependencies, configure the service, run migrations and start it.",
  "- Local mode: the platform has stood up the service's infra dependencies from its docker-compose file and exposed them on localhost; connect to them, run any DB migrations, then start the service and exercise it. If the service was marked as having no infra dependencies, just run the suite directly.",
  '- Ephemeral mode: a deployed environment URL (and access credentials) is provided in the run context; test against it rather than starting anything locally.',
  '',
  'What to test:',
  "- Cover THIS task's requirements first (from the block description / collected requirements above).",
  '- Then apply best judgement to regression-test related behaviour the change could plausibly affect — do not test the entire system, target the blast radius.',
  '- Run the existing automated suite where present, and add ad-hoc checks (API calls, flows) for behaviour the suite misses.',
  '',
  'Rules:',
  "- Make NO commits and open NO pull request — you only assess and report. Fixes are another agent's job.",
  '- Only greenlight when you are confident the change is correct and safe; any blocking bug or unresolved risk means greenlight=false with the concern listed.',
  '',
  TEST_REPORT_SHAPE,
].join('\n')

const FIXER_SYSTEM_PROMPT = [
  'You are a software engineer fixing problems a tester found on this pull-request branch.',
  'The tester’s structured report (what was tested, the outcomes, and the concerns/bugs to fix) is provided in the run context below.',
  '',
  'Address every concern the tester raised:',
  '- Reproduce each issue, find the root cause, and make the minimal correct change to fix it.',
  '- Do not disable, skip or weaken tests to make them pass; fix the underlying behaviour.',
  '- Keep the project building and the existing tests green.',
  '',
  'Commit your fixes to the current branch (no new branch, no new PR) so the tester can re-run against them.',
  '',
  STANDARDS_FOOTER,
].join('\n')

/** True when the kind is part of the Tester/Fixer track. */
export function isTestingKind(kind: AgentKind): boolean {
  return kind === TESTER_AGENT_KIND || kind === FIXER_AGENT_KIND
}

/** The built-out system prompt for a Tester/Fixer kind, or undefined otherwise. */
export function testingSystemPrompt(kind: AgentKind): string | undefined {
  if (kind === TESTER_AGENT_KIND) return TESTER_SYSTEM_PROMPT
  if (kind === FIXER_AGENT_KIND) return FIXER_SYSTEM_PROMPT
  return undefined
}

/**
 * The "which environment to run in" section for a Tester step, rendered from the
 * block's contributed `tester.environment` config value. Empty for non-tester kinds
 * or when nothing is set, so callers can append it unconditionally.
 */
export function testerEnvironmentSection(context: AgentRunContext): string {
  if (context.agentKind !== TESTER_AGENT_KIND) return ''
  const env = context.block.agentConfig?.[TESTER_ENVIRONMENT_CONFIG_ID]
  if (env === 'ephemeral') {
    return '\nRun mode: ephemeral environment — test against the provided environment URL; do not start the service locally.'
  }
  if (env === 'local') {
    return '\nRun mode: local — the service’s infra dependencies have been stood up on localhost; start the service yourself and test it there.'
  }
  return ''
}
