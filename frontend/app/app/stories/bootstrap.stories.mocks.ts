// Bootstrap runs, for the bootstrap step list, the adoption review and the failure card.
//
// A monorepo bootstrap writes a new service into an existing repository in three steps: survey
// both sides, a person settles the adoption decisions, then the run writes the service and opens
// a pull request. The step a run reached is derived from `phase`, `status`, `adoptionPlan` and
// `adoptionReview` (`bootstrapRunSteps` in contracts), so each builder below sets the four
// together, as the backend would.
import type {
  AdoptionDecision,
  AdoptionPlan,
  AdoptionRead,
  BootstrapJob,
  ReferenceArchitecture,
  ResolvedAdoption,
} from '@cat-factory/contracts'
import { STORY_WORKSPACE_ID } from './workspace'
import { failure } from './pipelineStep.stories.mocks'

/** The billing service frame the run materialises on the board. */
export const BILLING_FRAME_ID = 'svc_billing'

/** Three areas where the monorepo and the reference template disagree. */
export const adoptionDecisions: AdoptionDecision[] = [
  {
    id: 'build',
    area: 'build-tooling',
    title: 'Build and task runner',
    monorepoPractice: 'Turborepo pipelines in turbo.json, one tsup build per package.',
    templatePractice: 'A standalone esbuild script in scripts/build.mjs.',
    recommended: 'monorepo',
    rationale:
      'Every sibling service builds through the root turbo.json, so a separate script would ' +
      'not run in CI.',
    evidence: [
      'monorepo:turbo.json',
      'monorepo:services/payments/package.json',
      'template:scripts/build.mjs',
    ],
  },
  {
    id: 'testing',
    area: 'testing',
    title: 'Test runner',
    monorepoPractice: 'Vitest with the shared config in packages/test-config.',
    templatePractice: 'Vitest with a local vitest.config.ts and coverage thresholds.',
    recommended: 'both',
    rationale:
      'Extend the shared config, and keep the template coverage thresholds, which the ' +
      'monorepo does not set.',
    evidence: ['monorepo:packages/test-config/vitest.shared.ts', 'template:vitest.config.ts'],
  },
  {
    id: 'container',
    area: 'containerization',
    title: 'Container image',
    monorepoPractice: null,
    templatePractice: 'A multi-stage Dockerfile on node:22-slim.',
    recommended: 'template',
    rationale: 'The monorepo ships no images of its own; the services deploy as functions.',
    evidence: ['template:Dockerfile'],
  },
]

/**
 * What the survey read: the seeded paths first, then the ones the model asked for. A path names
 * its side with a `monorepo:` or `template:` prefix, and a decision may cite only a path that was
 * read (`surveyedPaths` in kernel's `monorepo-adoption.logic.ts`).
 */
export const surveyReads: AdoptionRead[] = [
  { path: 'monorepo:package.json', origin: 'seed', outcome: 'read', chars: 1840, note: null },
  { path: 'monorepo:turbo.json', origin: 'seed', outcome: 'read', chars: 612, note: null },
  { path: 'template:package.json', origin: 'seed', outcome: 'read', chars: 1320, note: null },
  {
    path: 'monorepo:services/payments/package.json',
    origin: 'model',
    outcome: 'read',
    chars: 1220,
    note: null,
  },
  {
    path: 'monorepo:packages/test-config/vitest.shared.ts',
    origin: 'model',
    outcome: 'read',
    chars: 940,
    note: null,
  },
  { path: 'template:scripts/build.mjs', origin: 'model', outcome: 'read', chars: 2210, note: null },
  { path: 'template:vitest.config.ts', origin: 'model', outcome: 'read', chars: 480, note: null },
  { path: 'template:Dockerfile', origin: 'model', outcome: 'read', chars: 760, note: null },
  { path: 'monorepo:Dockerfile', origin: 'model', outcome: 'absent', chars: 0, note: null },
  {
    path: 'monorepo:.env.production',
    origin: 'model',
    outcome: 'refused',
    chars: 0,
    note: 'Environment files are never read.',
  },
]

/** A ready plan over the three decisions, generated within its budget. */
export function adoptionPlan(overrides: Partial<AdoptionPlan> = {}): AdoptionPlan {
  return {
    status: 'ready',
    unavailableReason: null,
    unavailableDetail: null,
    survey: {
      reads: surveyReads,
      siblingServices: ['services/payments', 'services/ledger'],
      exploration: {
        calls: 7,
        maxCalls: 24,
        chars: 9382,
        maxChars: 54_000,
        exhausted: null,
        recordsDropped: 0,
      },
    },
    decisions: adoptionDecisions,
    droppedUnevidenced: [],
    model: 'anthropic:claude-sonnet-5-5',
    generatedAt: Date.UTC(2026, 9, 11, 10, 4),
    ...overrides,
  }
}

/** The review a person submitted: the recommendations, with the test runner overridden. */
export const adoptionReview: ResolvedAdoption = {
  decisions: adoptionDecisions.map((d) => ({
    id: d.id,
    area: d.area,
    title: d.title,
    choice: d.id === 'testing' ? 'monorepo' : d.recommended,
    overrodeRecommendation: d.id === 'testing',
    note: null,
  })),
  notes: null,
  reviewedByUserId: 'usr_maya',
  reviewedAt: Date.UTC(2026, 9, 11, 10, 20),
}

/**
 * A monorepo bootstrap of `services/billing` into `acme/platform`, still in its survey. The
 * other builders below move it on.
 */
export function bootstrapJob(overrides: Partial<BootstrapJob> = {}): BootstrapJob {
  return {
    id: 'boot_billing',
    workspaceId: STORY_WORKSPACE_ID,
    referenceArchitectureId: 'ref_node_service',
    referenceArchitectureName: 'Node service',
    repoName: 'billing',
    repoOwner: 'acme',
    repoUrl: null,
    instructions: 'A billing service that issues invoices and records payments.',
    status: 'running',
    blockId: BILLING_FRAME_ID,
    subtasks: null,
    error: null,
    failure: null,
    monorepo: {
      repoGithubId: 734_102,
      directory: 'services/billing',
      repoOwner: 'acme',
      repoName: 'platform',
      branch: null,
    },
    phase: 'survey',
    delivery: 'pull_request',
    adoptionPlan: null,
    adoptionReview: null,
    prUrl: null,
    createdAt: Date.UTC(2026, 9, 11, 9, 58),
    updatedAt: Date.UTC(2026, 9, 11, 10, 2),
    ...overrides,
  }
}

/** Parked on the review: the plan is ready and nobody has answered it. */
export function awaitingReviewJob(overrides: Partial<BootstrapJob> = {}): BootstrapJob {
  return bootstrapJob({
    status: 'awaiting_review',
    adoptionPlan: adoptionPlan(),
    updatedAt: Date.UTC(2026, 9, 11, 10, 4),
    ...overrides,
  })
}

/** Writing the service, after the review. */
export function applyingJob(overrides: Partial<BootstrapJob> = {}): BootstrapJob {
  return bootstrapJob({
    phase: 'apply',
    adoptionPlan: adoptionPlan(),
    adoptionReview,
    monorepo: { ...bootstrapJob().monorepo!, branch: 'cat-factory/bootstrap-billing' },
    subtasks: { completed: 3, inProgress: 1, total: 7 },
    updatedAt: Date.UTC(2026, 9, 11, 10, 31),
    ...overrides,
  })
}

/**
 * The apply step failed: the container was lost part way through. The hint is the backend's for
 * an evicted bootstrap (`FAILURE_HINTS` in `BootstrapService.ts`).
 */
export function failedApplyJob(): BootstrapJob {
  const lost = failure({
    message: 'The bootstrap container was lost mid-run.',
    hint:
      'The container that was running this job no longer has it — it was evicted, restarted, or ' +
      'crashed before completing. Inspect its stdout/stderr in the Cloudflare dashboard ' +
      '(Workers Observability → container logs, filtered by this job id), then retry to spin a ' +
      'fresh container.',
    occurredAt: Date.UTC(2026, 9, 11, 10, 42),
    lastSubtasks: { completed: 4, inProgress: 1, total: 7 },
    stepIndex: undefined,
  })
  return applyingJob({
    status: 'failed',
    error: lost.message,
    failure: lost,
    updatedAt: lost.occurredAt,
  })
}

/** A new-repository run from scratch that finished, with the address of the repo it pushed. */
export function succeededNewRepoJob(): BootstrapJob {
  return bootstrapJob({
    id: 'boot_notifications',
    referenceArchitectureId: null,
    referenceArchitectureName: null,
    repoName: 'notifications',
    repoUrl: 'https://github.com/acme/notifications',
    instructions: 'A service that sends email and push notifications from a queue.',
    status: 'succeeded',
    blockId: 'svc_notifications',
    monorepo: null,
    phase: null,
    delivery: 'direct_push',
    createdAt: Date.UTC(2026, 9, 9, 15, 12),
    updatedAt: Date.UTC(2026, 9, 9, 15, 26),
  })
}

/**
 * The reference architectures the workspace manages: the Node service the runs above use, and a
 * Go worker.
 */
export const referenceArchitectures: ReferenceArchitecture[] = [
  {
    id: 'ref_node_service',
    workspaceId: STORY_WORKSPACE_ID,
    name: 'Node service',
    description: 'Fastify, Drizzle and Vitest, with the platform CI workflow.',
    repoOwner: 'acme',
    repoName: 'node-service-template',
    defaultInstructions:
      'Keep the health and metrics endpoints. Name the package after the service.',
    createdAt: Date.UTC(2026, 8, 2),
    updatedAt: Date.UTC(2026, 8, 20),
  },
  {
    id: 'ref_go_worker',
    workspaceId: STORY_WORKSPACE_ID,
    name: 'Go worker',
    description: 'A queue consumer with structured logging.',
    repoOwner: 'acme',
    repoName: 'go-worker-template',
    defaultInstructions: '',
    createdAt: Date.UTC(2026, 8, 14),
    updatedAt: Date.UTC(2026, 8, 14),
  },
]
