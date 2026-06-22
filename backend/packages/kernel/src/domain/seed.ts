import { mergeRegisteredPipelines } from './pipeline-registry.js'
import type { Block, Pipeline } from './types.js'

// Sample architecture used to populate a workspace on creation. Mirrors the
// frontend's `app/utils/seed.ts`. Block ids are stable strings; because blocks
// are keyed by (workspace_id, id) every workspace gets its own copy, so reusing
// these ids across workspaces is safe.

export function seedBlocks(): Block[] {
  const base = (b: Partial<Block> & Pick<Block, 'id' | 'title' | 'type' | 'position'>): Block => ({
    description: '',
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
    ...b,
  })

  return [
    base({
      id: 'blk_frontend',
      title: 'Web Frontend',
      type: 'frontend',
      position: { x: 80, y: 80 },
      description: 'Customer-facing SPA consuming the API gateway.',
      status: 'planned',
    }),
    base({
      id: 'blk_api',
      title: 'API Gateway',
      type: 'api',
      position: { x: 620, y: 80 },
      description: 'Single entrypoint; routing, rate limiting, auth checks.',
      status: 'planned',
    }),
    base({
      id: 'blk_payments',
      title: 'Payments (External)',
      type: 'external',
      position: { x: 1160, y: 80 },
      description: 'Third-party payment provider integration.',
      status: 'planned',
    }),
    base({
      id: 'blk_auth',
      title: 'Auth Service',
      type: 'service',
      position: { x: 80, y: 580 },
      description: 'Issues and validates sessions and access tokens.',
      status: 'ready',
    }),
    base({
      id: 'blk_db',
      title: 'Core Database',
      type: 'database',
      position: { x: 620, y: 580 },
      description: 'Primary relational store for users, accounts and orders.',
      status: 'done',
      progress: 1,
    }),
    base({
      id: 'blk_queue',
      title: 'Notification Queue',
      type: 'queue',
      position: { x: 1160, y: 580 },
      description: 'Async fan-out for emails and push notifications.',
      status: 'planned',
    }),

    // Tasks (draggable) inside the Auth Service.
    base({
      id: 'task_login',
      title: 'Login endpoint',
      type: 'service',
      position: { x: 24, y: 96 },
      description: 'Issue a session on valid credentials.',
      status: 'planned',
      level: 'task',
      parentId: 'blk_auth',
      moduleName: 'Sessions',
    }),
    base({
      id: 'task_refresh',
      title: 'Token refresh',
      type: 'service',
      position: { x: 230, y: 96 },
      description: 'Rotate access tokens against a refresh token.',
      status: 'planned',
      level: 'task',
      parentId: 'blk_auth',
      moduleName: 'Sessions',
      dependsOn: ['task_login'],
    }),

    // A module that already exists, with an implemented task living inside it.
    base({
      id: 'mod_sessions',
      title: 'Sessions',
      type: 'service',
      position: { x: 24, y: 250 },
      description: 'Session lifecycle module.',
      level: 'module',
      parentId: 'blk_auth',
    }),
    base({
      id: 'task_session',
      title: 'Session store',
      type: 'service',
      position: { x: 16, y: 40 },
      description: 'Persist and look up active sessions.',
      status: 'done',
      progress: 1,
      level: 'task',
      parentId: 'mod_sessions',
      moduleName: 'Sessions',
      confidence: 0.92,
    }),
  ]
}

/**
 * Reusable pipelines shown in the pipeline palette on first load: the built-in catalog
 * plus any pipelines a deployment registered via `registerPipeline` (e.g. a proprietary
 * org package), merged by id.
 */
export function seedPipelines(): Pipeline[] {
  const builtins: Pipeline[] = [
    {
      id: 'pl_full',
      name: 'Full build',
      // `requirements` runs first and reviews the collected requirements; the
      // spec-writer then folds them into the in-repo spec, and only THEN does the
      // architect design the solution — against that written spec (the architect is
      // spec-aware, so it reads `spec/` from its checkout). The requirements review and
      // the architecture pause for human approval (their proposals are reviewed/edited
      // before the next step); the spec is NOT human-gated — its `spec-companion`
      // (Spec Reviewer) rates it and loops the spec-writer back automatically instead.
      // `blueprints` runs right after implementation so the service map (and the board)
      // is refreshed from the just-written code, on the same PR branch. `conflicts`
      // then ensures the PR is mergeable with its base — looping a `conflict-resolver`
      // agent to merge the base in and resolve any conflicts — `ci` gates the
      // (now-final, up-to-date) PR branch on green CI — looping a `ci-fixer` agent on
      // failure — and `merger` runs last: it scores the PR and either auto-merges
      // (within the task's thresholds) or raises a review notification.
      agentKinds: [
        'requirements-review',
        // The spec-writer aggregates every task's clarified requirements into the
        // service's unified in-repo `spec/` document, committed to the shared work
        // branch BEFORE the architect and coder run — so the spec (and its Gherkin
        // acceptance scenarios) is the source of truth the architect designs against
        // and the code is written to satisfy. Every task's work branch is created up
        // front, so the read-only architect reads what the spec-writer committed. It
        // is NOT human-gated: the `spec-companion` (Spec Reviewer) below rates the
        // spec and loops the spec-writer back for automatic rework below threshold.
        'spec-writer',
        // `spec-companion` is the spec-writer's optional reviewer: it grades the
        // spec (especially acceptance-scenario coverage), and below its threshold
        // loops the spec-writer back with the feedback folded in — replacing the
        // human review the spec used to require.
        'spec-companion',
        'architect',
        'researcher',
        'coder',
        'blueprints',
        // `mocker` stands up the external-dependency mocks the tester needs to run
        // the suite locally, so it always runs immediately before `tester`.
        'mocker',
        'tester',
        // `reviewer` is the coder's companion: it rates the change and loops it back
        // for automatic rework when quality is below threshold (see companions).
        'reviewer',
        'conflicts',
        'ci',
        'merger',
      ],
      // Gate only the context requirements review (index 0) and the architecture
      // proposal (`architect`, index 3). The spec is NO LONGER human-gated — its
      // `spec-companion` (index 2) is the quality gate (rate + automatic rework). The
      // `mocker` / `tester` / `conflicts` / `ci` / `merger` tail is never human-gated
      // (it gates/decides itself), so those slots are false too.
      gates: [
        true,
        false,
        false,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ],
    },
    {
      // The most thorough preset: a complex, full-stack feature run that engages
      // every valuable agent so no angle is left uncovered. It extends "Full build"
      // with the up-front researcher, the acceptance-scenario author, the external-
      // dependency mock builder, the business-logic documenter and the developer
      // documenter, in addition to the runnable end-to-end (`playwright`) tests:
      //
      //   requirements-review → analyse + clarify the collected context (human gate)
      //   researcher          → investigate prior art, libraries and constraints
      //   spec-writer         → aggregate the clarified spec (+ acceptance scenarios)
      //                         onto the shared work branch BEFORE the design/code
      //   spec-companion      → challenge acceptance-scenario coverage; loop the
      //                         spec-writer back below threshold (no human gate)
      //   architect           → design the solution against the written spec
      //   architect-companion → challenge the design's quality; loop back below
      //                         threshold, then raise the human gate on a pass
      //   mocker        → stand up mocks for the external dependencies
      //   coder         → implement the feature on the implementation branch
      //   blueprints    → refresh the in-repo service map from the new code
      //   business-documenter → capture the domain rules the code now encodes
      //   tester        → define the unit / integration test strategy
      //   playwright    → author the runnable end-to-end / acceptance TESTS (from the
      //                   spec's derived Gherkin)
      //   reviewer      → coder's companion: rate the change, loop back for rework
      //   documenter    → write the developer-facing documentation
      //   conflicts → ci → merger → the same mergeability / CI / merge tail as Full build
      id: 'pl_fullstack',
      name: 'Complex fullstack feature',
      agentKinds: [
        'requirements-review',
        'researcher',
        'spec-writer',
        'spec-companion',
        'architect',
        'architect-companion',
        'mocker',
        'coder',
        'blueprints',
        'business-documenter',
        'tester',
        'playwright',
        'reviewer',
        'documenter',
        'conflicts',
        'ci',
        'merger',
      ],
      // Human gates: the context requirements review (index 0) and — after its
      // companion has cleared the quality bar — the architecture (on `architect-
      // companion`, index 5). The spec is NOT human-gated: its `spec-companion`
      // (index 3) rates it and loops the spec-writer back automatically. Every other
      // step (including the self-gating conflicts / ci / merger tail and the auto-only
      // `reviewer` companion) runs straight through.
      gates: [
        true,
        false,
        false,
        false,
        false,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ],
    },
    {
      id: 'pl_quick',
      name: 'Quick implement',
      agentKinds: ['coder', 'blueprints', 'mocker', 'tester', 'conflicts', 'ci', 'merger'],
    },
    {
      id: 'pl_integrate',
      name: 'Integrate & ship',
      agentKinds: ['integrator', 'mocker', 'tester', 'documenter'],
    },
    // Recurring-pipeline presets. "Dependency updates" is a plain implement →
    // review → merge run; "Tech debt" first runs a read-only `analysis` agent and
    // a special `tracker` step (files a GitHub issue / Jira ticket from the
    // analysis) before implementation. Both are picked when creating a recurring
    // pipeline on a service.
    {
      id: 'pl_dep_update',
      name: 'Dependency updates',
      agentKinds: [
        'coder',
        'blueprints',
        'mocker',
        'tester',
        'reviewer',
        'conflicts',
        'ci',
        'merger',
      ],
    },
    {
      id: 'pl_tech_debt',
      name: 'Tech debt',
      agentKinds: [
        'analysis',
        'tracker',
        'coder',
        'blueprints',
        'mocker',
        'tester',
        'reviewer',
        'conflicts',
        'ci',
        'merger',
      ],
    },
    // A blueprint-only pipeline, run after a bootstrap to create the initial
    // service map (and populate the board) from the freshly bootstrapped repo.
    { id: 'pl_blueprint', name: 'Map service', agentKinds: ['blueprints'] },
    // A spec-only pipeline, to (re)generate a service's unified in-repo specification
    // (and its Gherkin acceptance scenarios) independently.
    { id: 'pl_spec', name: 'Write spec', agentKinds: ['spec-writer'] },
  ]
  // Every curated catalog pipeline is a read-only template: it can be cloned into an
  // editable copy but not edited in place (see PipelineService.update / clone).
  return mergeRegisteredPipelines(builtins.map((p) => ({ ...p, builtin: true })))
}

/** Pipeline id of the blueprint-only run kicked off after a successful bootstrap. */
export const BLUEPRINT_PIPELINE_ID = 'pl_blueprint'

/** Pipeline ids of the built-in recurring-pipeline presets. */
export const DEP_UPDATE_PIPELINE_ID = 'pl_dep_update'
export const TECH_DEBT_PIPELINE_ID = 'pl_tech_debt'
