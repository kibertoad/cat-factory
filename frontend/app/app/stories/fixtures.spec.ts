import {
  agentFailureSchema,
  blockSchema,
  companionVerdictSchema,
  decisionSchema,
  githubAvailableRepoSchema,
  githubBranchSchema,
  githubConnectionSchema,
  githubInstallationOptionSchema,
  githubIssueSchema,
  githubPullRequestSchema,
  githubRepoSchema,
  priorStepOutputSchema,
  prReviewStatusSchema,
  prReviewStepStateSchema,
  runInputGateSchema,
  serviceSchema,
  stepApprovalSchema,
  taskEstimateSchema,
  vcsConnectOptionSchema,
  workspaceSnapshotSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { block, estimate } from './block.stories.mocks'
import { authInitiative } from './board.stories.mocks'
import {
  approval,
  blockedInputGate,
  companionVerdicts,
  decision,
  failure,
  priorOutput,
  prReview,
} from './pipelineStep.stories.mocks'
import { execution, parkedExecution, snapshot } from './snapshot.stories.mocks'
import {
  authBranches,
  authRepo,
  authServiceRow,
  availableRepos,
  gatewayRepo,
  githubConnection,
  githubInstallations,
  githubIssues,
  platformRepo,
  pullRequests,
  vcsConnectOptions,
} from './vcs.stories.mocks'

// The shared story fixtures, each parsed with the contract schema the backend answers with. The
// typecheck already holds them to the TYPE; this also holds them to what the type cannot say (an
// id pattern, a minimum, a non-empty list), so a story never renders a row the API would refuse.
const cases: [string, v.GenericSchema, unknown[]][] = [
  ['block', blockSchema, [block(), authInitiative]],
  ['task estimate', taskEstimateSchema, [estimate()]],
  ['GitHub connection', githubConnectionSchema, [githubConnection]],
  ['service', serviceSchema, [authServiceRow]],
  ['GitHub branch', githubBranchSchema, authBranches],
  ['GitHub repo', githubRepoSchema, [authRepo, platformRepo, gatewayRepo]],
  ['step approval', stepApprovalSchema, [approval()]],
  ['agent failure', agentFailureSchema, [failure()]],
  ['prior step output', priorStepOutputSchema, [priorOutput()]],
  ['PR review state', prReviewStepStateSchema, prReviewStatusSchema.options.map(prReview)],
  ['step decision', decisionSchema, [decision(), decision({ chosen: 'In process only' })]],
  ['companion verdict', companionVerdictSchema, companionVerdicts],
  ['input gate', runInputGateSchema, [blockedInputGate]],
  ['available repo', githubAvailableRepoSchema, availableRepos],
  ['GitHub installation', githubInstallationOptionSchema, githubInstallations],
  ['VCS connect option', vcsConnectOptionSchema, vcsConnectOptions],
  ['pull request', githubPullRequestSchema, pullRequests],
  ['GitHub issue', githubIssueSchema, githubIssues],
  [
    'board snapshot',
    workspaceSnapshotSchema,
    [snapshot(), snapshot({ executions: [execution(), parkedExecution()] })],
  ],
]

describe('shared story fixtures', () => {
  it.each(cases)('every %s matches its contract schema', (_name, schema, rows) => {
    for (const row of rows) {
      const result = v.safeParse(schema, row)
      expect(
        result.issues?.map((issue) => `${v.getDotPath(issue)}: ${issue.message}`),
      ).toBeUndefined()
    }
  })
})

// Components join a repo on its `githubId`, so a repo listed under two ids shows up unlinked, or
// twice, in a story that seeds one fixture and lists the other.
describe('the repo fixtures', () => {
  it('give each repo one githubId', () => {
    const ids = new Map<string, Set<number>>()
    for (const repo of [authRepo, platformRepo, gatewayRepo, ...availableRepos]) {
      const name = `${repo.owner}/${repo.name}`
      ids.set(name, (ids.get(name) ?? new Set()).add(repo.githubId))
    }
    expect([...ids].filter(([, set]) => set.size > 1).map(([name]) => name)).toEqual([])
  })
})
