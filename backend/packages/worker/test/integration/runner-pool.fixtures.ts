import type { RunnerPoolManifest } from '@cat-factory/kernel'

// Shared fixtures for the self-hosted runner-pool tests. The real
// HttpRunnerPoolProvider is exercised against a stubbed global `fetch` that acts
// as an org's pool scheduler API and records every request. (`recordingFetch`
// lives in environment.fixtures — it is provider-agnostic.)

export const RUNNER_API_TOKEN = 'super-secret-runner-token'
export const RUNNER_BASE = 'https://pool.test/api'

/** A representative pool manifest (bearer-auth) the specs register and tweak. */
export function bearerRunnerManifest(
  overrides: Partial<RunnerPoolManifest> = {},
): RunnerPoolManifest {
  return {
    providerId: 'acme-pool',
    label: 'Acme Runner Pool',
    baseUrl: RUNNER_BASE,
    auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
    // A transparent scheduler: forward the harness job verbatim under `job`, keyed
    // on the cat-factory job id so poll/release address it by the same id.
    dispatch: {
      method: 'POST',
      pathTemplate: '/jobs',
      bodyTemplate: '{"id":"{{input.jobId}}","job":{{input.job}}}',
    },
    poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
    release: { method: 'DELETE', pathTemplate: '/jobs/{{input.jobId}}' },
    response: {
      statusPath: 'state',
      statusMap: [
        { from: 'in_progress', to: 'running' },
        { from: 'succeeded', to: 'done' },
        { from: 'errored', to: 'failed' },
      ],
      progressCompletedPath: 'progress.completed',
      progressInProgressPath: 'progress.inProgress',
      progressTotalPath: 'progress.total',
      prUrlPath: 'result.pr_url',
      branchPath: 'result.branch',
      summaryPath: 'result.summary',
      errorPath: 'error',
    },
    ...overrides,
  }
}

/** A minimal, well-formed harness job spec (the dispatch payload). */
export function sampleJobSpec(): Record<string, unknown> {
  return {
    jobId: 'ex-1',
    systemPrompt: 'You are a coder.',
    userPrompt: 'Implement the rate limiter.',
    model: 'qwen3-max',
    proxyBaseUrl: 'https://worker.example/v1',
    sessionToken: 'session-tok',
    ghToken: 'gh-tok',
    repo: {
      owner: 'octo',
      name: 'app',
      baseBranch: 'main',
      cloneUrl: 'https://github.com/octo/app.git',
    },
    headBranch: 'cat-factory/blk-1-abcd1234',
    pr: { title: 'Rate limiter', body: 'body' },
  }
}
