// What the Docker Compose setup wizard reads for the shared board's Auth Service: the detector's
// recommendation for its repository, and the environment analyst's draft. The note messages follow
// the backend's wording (`buildComposeRecommendation` in integrations); the repository's files,
// services and the analyst's reading of them are made up.
import type {
  AnalystRecipeDraft,
  ExecutionInstance,
  ProvisioningRecommendation,
} from '@cat-factory/contracts'
import { adHocPipelineIdFor, ENVIRONMENT_ANALYST_AGENT_KIND } from '@cat-factory/contracts'
import { authService } from './board.stories.mocks'
import { step } from './pipelineStep.stories.mocks'

/**
 * A compose file with three services and an override family: the base and its auto-merge
 * override layered, a macOS and a WSL override offered, one optional profile, and one seed dump.
 */
export function composeRecommendation(
  overrides: Partial<ProvisioningRecommendation> = {},
): ProvisioningRecommendation {
  return {
    detected: true,
    provisioning: {
      type: 'docker-compose',
      composePath: 'docker-compose.yml',
      recipe: {
        composeFiles: ['docker-compose.yml', 'docker-compose.override.yml'],
        envFiles: [{ template: '.env.dist', target: '.env' }],
      },
    },
    composeServiceCandidates: [
      { composePath: 'docker-compose.yml', service: 'auth', recommended: true },
      { composePath: 'docker-compose.yml', service: 'postgres', recommended: false },
      { composePath: 'docker-compose.yml', service: 'redis', recommended: false },
    ],
    composeFileCandidates: [
      { path: 'docker-compose.yml', name: 'docker-compose.yml', recommended: true },
      {
        path: 'docker-compose.override.yml',
        name: 'docker-compose.override.yml',
        recommended: true,
      },
      {
        path: 'docker-compose.mac.yml',
        name: 'docker-compose.mac.yml',
        os: 'mac',
        recommended: false,
      },
      {
        path: 'docker-compose.wsl.override.yml',
        name: 'docker-compose.wsl.override.yml',
        os: 'wsl',
        recommended: false,
      },
    ],
    profileCandidates: [{ profile: 'observability', recommended: false }],
    seedDumpCandidates: [{ path: 'db/seed/auth.sql', name: 'auth.sql', recommended: true }],
    notes: [
      {
        field: 'provisionType',
        confidence: 'high',
        message: 'Detected a Docker Compose file at docker-compose.yml.',
      },
      {
        field: 'composeService',
        confidence: 'low',
        message:
          'The compose file declares 3 services; pre-selected "auth" for this block. The file is ' +
          "the deploy target — the service choice is advisory; pick another if that's wrong.",
      },
      {
        field: 'composeFiles',
        confidence: 'high',
        message:
          'Layered 2 compose file(s): docker-compose.yml → docker-compose.override.yml. 2 ' +
          'OS-specific override(s) surfaced — pick the one matching your machine.',
      },
      {
        field: 'envFiles',
        confidence: 'low',
        message:
          'Found 1 env/config template(s) to materialize before up: .env.dist → .env. Confirm ' +
          'each pair.',
      },
      {
        field: 'composeProfiles',
        confidence: 'low',
        message:
          'The compose file declares 1 profile(s): observability. All surfaced default-off — ' +
          'enable the optional service groups you need.',
      },
      {
        field: 'seedDump',
        confidence: 'low',
        message:
          'Found 1 SQL seed dump(s) (pre-selected db/seed/auth.sql). Confirm one to import as a ' +
          'seed step; none is applied automatically.',
      },
    ],
    ...overrides,
  }
}

/** The same repository with its own bring-up script, which the detector flags and cannot read. */
export function composeRecommendationWithCli(): ProvisioningRecommendation {
  const base = composeRecommendation()
  return {
    ...base,
    repoCliHint: { path: 'bin/dev-console', kind: 'repo-cli' },
    notes: [
      ...base.notes,
      {
        field: 'repoCli',
        confidence: 'low',
        message:
          'This repo has its own imperative bring-up (repo-cli at bin/dev-console); the ' +
          "deterministic scan can't read it. Consider running deep analysis to translate its " +
          'setup into recipe steps.',
      },
    ],
  }
}

/**
 * The analyst's reading of `bin/dev-console`: the migrations and the seed import it runs, the
 * health check it waits on, and Docker as a prerequisite. It also proposes compose files, which
 * the detector's own pick overrides.
 */
export const analystDraft: AnalystRecipeDraft = {
  summary:
    'bin/dev-console up starts the stack from docker-compose.yml, runs the migrations in the ' +
    'auth container, imports db/seed/auth.sql into postgres, and waits until /healthz answers.',
  recipe: {
    composeFiles: ['docker-compose.yml'],
    prerequisites: [{ check: 'docker-daemon' }],
    setupSteps: [
      {
        kind: 'compose-exec',
        name: 'Run migrations',
        service: 'auth',
        command: ['pnpm', 'db:migrate'],
      },
      {
        kind: 'compose-exec',
        name: 'Import seed auth.sql',
        service: 'postgres',
        command: ['psql', '-U', 'auth', 'auth'],
        stdinFile: 'db/seed/auth.sql',
      },
    ],
    healthGate: { kind: 'http', url: 'http://localhost:8080/healthz', expectStatus: 200 },
  },
  notes: [
    {
      field: 'setupSteps',
      rationale: 'dev-console runs the migrations, then pipes the seed dump into psql.',
      citations: [{ path: 'bin/dev-console', lines: '41-58' }],
    },
    {
      field: 'healthGate',
      rationale: 'dev-console polls /healthz until it answers 200.',
      citations: [{ path: 'bin/dev-console', lines: '63' }],
    },
  ],
}

/** The analyst's single-kind run on the Auth Service frame, done, with its draft on the step. */
export function analystRun(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_env_analyst',
    blockId: authService.id,
    pipelineId: adHocPipelineIdFor(ENVIRONMENT_ANALYST_AGENT_KIND),
    pipelineName: 'Environment analyst',
    steps: [
      step({
        agentKind: ENVIRONMENT_ANALYST_AGENT_KIND,
        state: 'done',
        progress: 1,
        custom: analystDraft,
      }),
    ],
    currentStep: 0,
    status: 'done',
    ...overrides,
  }
}
