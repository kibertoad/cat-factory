import {
  blockSchema,
  companionVerdictSchema,
  decisionSchema,
  githubAvailableRepoSchema,
  githubInstallationOptionSchema,
  githubIssueSchema,
  githubPullRequestSchema,
  githubRepoSchema,
  runInputGateSchema,
  stepApprovalSchema,
  vcsConnectOptionSchema,
  workspaceSnapshotSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { authInitiative } from './board.stories.mocks'
import {
  approval,
  blockedInputGate,
  companionVerdicts,
  decision,
} from './pipelineStep.stories.mocks'
import { execution, parkedExecution, snapshot } from './snapshot.stories.mocks'
import {
  authRepo,
  availableRepos,
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
  ['initiative block', blockSchema, [authInitiative]],
  ['GitHub repo', githubRepoSchema, [authRepo, platformRepo]],
  ['step approval', stepApprovalSchema, [approval()]],
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
