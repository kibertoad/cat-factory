// Built-in pipelines as the board snapshot carries them, for the pipeline pickers, previews and
// builders. Copies of the backend's seeds (`backend/packages/kernel/src/domain/seed.ts`): ids,
// names, descriptions, steps, gates and conditions, as `definePipeline` lays them out. A copy can
// go stale. `buildPipeline` in `snapshot.stories.mocks.ts` stays the small three-step pipeline the
// board stories run; these are the real ones.
import type { CustomAgentKind } from '@cat-factory/contracts'
import type { Pipeline } from '~/types/domain'

/** The default: no human pause, and each tester runs only for its side of the service. */
export const standardBuild: Pipeline = {
  id: 'pl_build',
  name: 'Standard build',
  purpose: 'build',
  description:
    'The default: design the solution and challenge the design, implement and review the change, then verify it — the browser pass on a frontend, the API pass behind it — before gating on conflicts + CI and merging. No requirements interview, no human pauses.',
  version: 3,
  isDefault: true,
  builtin: true,
  agentKinds: [
    'architect',
    'architect-companion',
    'coder',
    'reviewer',
    'deployer',
    'tester-api',
    'tester-ui',
    'conflicts',
    'ci',
    'merger',
    'disposer',
  ],
  stepOptions: [
    null,
    null,
    null,
    null,
    null,
    { condition: { serviceScope: 'backend' } },
    { condition: { serviceScope: 'frontend' } },
    null,
    null,
    null,
    null,
  ],
}

/** Sizes the task first; the design, the testers and a human review switch on for bigger tasks. */
export const adaptiveBuild: Pipeline = {
  id: 'pl_full',
  name: 'Adaptive build',
  purpose: 'build',
  description:
    'Sizes the task up first, then designs it only when it needs designing, implements and reviews, verifies, and gates on conflicts + CI before merging. Optional steps switch themselves on for bigger tasks — a risky change also waits for a human review on the PR.',
  version: 8,
  builtin: true,
  agentKinds: [
    'task-estimator',
    'architect',
    'architect-companion',
    'coder',
    'reviewer',
    'deployer',
    'tester-api',
    'tester-ui',
    'conflicts',
    'ci',
    'human-review',
    'merger',
    'disposer',
  ],
  gating: [
    null,
    { enabled: true, minComplexity: 0.4, onMissingEstimate: 'run' },
    null,
    null,
    null,
    null,
    { enabled: true, minComplexity: 0.3, minRisk: 0.3, onMissingEstimate: 'run' },
    { enabled: true, minComplexity: 0.3, minRisk: 0.3, onMissingEstimate: 'run' },
    null,
    null,
    { enabled: true, minRisk: 0.8, onMissingEstimate: 'skip' },
    null,
    null,
  ],
  stepOptions: [
    null,
    null,
    null,
    null,
    null,
    null,
    { condition: { serviceScope: 'backend' } },
    { condition: { serviceScope: 'frontend' } },
    null,
    null,
    null,
    null,
    null,
  ],
}

/**
 * The `repro-test` kind the bugfix pipeline runs. It is registered through `registerAgentKind`
 * (`kinds/repro-test.ts` in agents), so the SPA's own catalog has no entry for it and the snapshot
 * projects it in `customAgentKinds`. A story showing the bugfix pipeline seeds it, or the step
 * reads as an unknown kind.
 */
export const reproTestKind: CustomAgentKind = {
  kind: 'repro-test',
  container: true,
  presentation: {
    label: 'Reproduction Test',
    icon: 'i-lucide-flask-conical',
    color: '#f59e0b',
    description:
      'Writes one or more tests that fail for the reported reason (or concedes when the bug ' +
      'cannot be reproduced), committing them so the fix has a red test to turn green.',
    category: 'test',
    tier: 'intermediate',
    resultView: 'generic-structured',
  },
}

/** A bugfix that stops once for a person to triage the report. */
export const bugfixPipeline: Pipeline = {
  id: 'pl_bugfix',
  name: 'Triage & fix bug',
  purpose: 'bugfix',
  description:
    'Investigate a bug report against the codebase, triage it for fixability with you, write a failing reproduction test, then fix, review, and ship the PR.',
  version: 5,
  builtin: true,
  agentKinds: [
    'bug-investigator',
    'clarity-review',
    'spec-writer',
    'architect',
    'repro-test',
    'coder',
    'reviewer',
    'conflicts',
    'ci',
    'merger',
  ],
  gates: [false, true, false, false, false, false, false, false, false, false],
}

/** The default for a document task: research, outline, interview, write, review, then ship. */
export const documentPipeline: Pipeline = {
  id: 'pl_document',
  name: 'Author a document',
  purpose: 'document',
  description:
    'Turn a brief and its linked context into a polished in-repo Markdown document — research, outline, interview, write, review, then gate and ship the PR.',
  version: 5,
  builtin: true,
  agentKinds: [
    'doc-researcher',
    'doc-outliner',
    'doc-interviewer',
    'doc-writer',
    'doc-reviewer',
    'doc-finalizer',
    'doc-quality',
    'conflicts',
    'ci',
    'merger',
  ],
  gates: [false, false, false, false, true, false, false, false, false, false],
}

/** The default for a review task: a read-only review of an open pull request. */
export const reviewPipeline: Pipeline = {
  id: 'pl_review',
  name: 'Review a pull request',
  purpose: 'review',
  description:
    'A read-only deep review of an open pull request that returns prioritized findings — no code is written and no PR is opened. Built for large PRs: it slices the diff into cohesive chunks and reviews each one, so it can work through a big change over a longer run rather than choking on it in a single pass.',
  version: 4,
  builtin: true,
  agentKinds: ['pr-reviewer'],
}

/** The default for a bug-fishing task: one pass per angle, then a task per marked finding. */
export const bugFishingPipeline: Pipeline = {
  id: 'pl_bug_fishing',
  name: 'Bug fishing expedition',
  purpose: 'research',
  description:
    'Systematically hunt an existing codebase for genuine defects, logic gaps, footguns and unhandled edge cases — one pass per angle — then spawn a bug-fix task for each finding you mark.',
  version: 1,
  builtin: true,
  agentKinds: ['bug-fisher'],
}

/**
 * The recurring twin of the bugfix: each fire pulls one issue from the schedule's tracker board
 * (`bug-intake`). Recurring only, so no task form offers it; the schedule form does.
 */
export const bugTriagePipeline: Pipeline = {
  id: 'pl_bug_triage',
  name: 'Bug triage (recurring)',
  purpose: 'bugfix',
  description:
    'A recurring run that pulls one open issue from your tracker board, investigates and clarifies it, then fixes, tests, and ships the PR, reclaiming the environment it stood up.',
  version: 6,
  builtin: true,
  availability: 'recurring',
  agentKinds: [
    'bug-intake',
    'bug-investigator',
    'clarity-review',
    'task-estimator',
    'repro-test',
    'coder',
    'reviewer',
    'deployer',
    'tester-api',
    'conflicts',
    'ci',
    'merger',
    'disposer',
  ],
  gates: [false, false, true, false, false, false, false, false, false, false, false, false, false],
}
