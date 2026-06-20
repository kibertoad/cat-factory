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
      // architect then designs the solution. Both pause for human approval (their
      // proposals are reviewed/edited before the next step), while `blueprints`
      // runs right after implementation so the service map (and the board) is
      // refreshed from the just-written code, on the same PR branch. `conflicts`
      // then ensures the PR is mergeable with its base — looping a `conflict-resolver`
      // agent to merge the base in and resolve any conflicts — `ci` gates the
      // (now-final, up-to-date) PR branch on green CI — looping a `ci-fixer` agent on
      // failure — and `merger` runs last: it scores the PR and either auto-merges
      // (within the task's thresholds) or raises a review notification.
      agentKinds: [
        'requirements',
        'architect',
        // After the requirements review + architecture are settled, the
        // requirements-writer aggregates every task's clarified requirements into the
        // service's unified in-repo `requirements/` document, committed to the
        // implementation branch BEFORE the coder runs so the spec (and its Gherkin
        // acceptance scenarios) is present while the code is written.
        'requirements-writer',
        'researcher',
        'coder',
        'blueprints',
        'tester',
        'reviewer',
        'conflicts',
        'ci',
        'merger',
      ],
      // Gate the requirements review and the architecture proposal. The
      // requirements-writer, `conflicts` / `ci` / `merger` are never human-gated
      // (they aggregate/gate/decide themselves), so their slots are false.
      gates: [true, true, false, false, false, false, false, false, false, false, false],
    },
    {
      id: 'pl_quick',
      name: 'Quick implement',
      agentKinds: ['coder', 'blueprints', 'tester', 'conflicts', 'ci', 'merger'],
    },
    {
      id: 'pl_integrate',
      name: 'Integrate & ship',
      agentKinds: ['integrator', 'tester', 'documenter'],
    },
    // Recurring-pipeline presets. "Dependency updates" is a plain implement →
    // review → merge run; "Tech debt" first runs a read-only `analysis` agent and
    // a special `tracker` step (files a GitHub issue / Jira ticket from the
    // analysis) before implementation. Both are picked when creating a recurring
    // pipeline on a service.
    {
      id: 'pl_dep_update',
      name: 'Dependency updates',
      agentKinds: ['coder', 'blueprints', 'tester', 'reviewer', 'conflicts', 'ci', 'merger'],
    },
    {
      id: 'pl_tech_debt',
      name: 'Tech debt',
      agentKinds: [
        'analysis',
        'tracker',
        'coder',
        'blueprints',
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
    // A requirements-only pipeline, to (re)generate a service's unified in-repo
    // requirements document (and its Gherkin acceptance scenarios) independently.
    { id: 'pl_requirements', name: 'Write requirements', agentKinds: ['requirements-writer'] },
  ]
  return mergeRegisteredPipelines(builtins)
}

/** Pipeline id of the blueprint-only run kicked off after a successful bootstrap. */
export const BLUEPRINT_PIPELINE_ID = 'pl_blueprint'

/** Pipeline ids of the built-in recurring-pipeline presets. */
export const DEP_UPDATE_PIPELINE_ID = 'pl_dep_update'
export const TECH_DEBT_PIPELINE_ID = 'pl_tech_debt'
