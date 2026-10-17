import type { Meta, StoryObj } from '@storybook/vue3'
import type { ConsensusSession } from '@cat-factory/contracts'
import { getConsensusSessionContract } from '@cat-factory/contracts'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { claudeOnlyCatalog } from '~/stories/providers.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedModelCatalog, seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import ConsensusSessionWindow from './ConsensusSessionWindow.vue'

// The record of a step that several models worked on together: who was on the panel and on which
// model, each round's contributions (anonymised as the models saw each other), and the combined
// result with its confidence and the points still in dispute. It loads the task's latest session
// when it opens, so each story answers that read. The model catalog is seeded so a participant's
// model can have its name. The architect's debate on the login task is made up.
function session(overrides: Partial<ConsensusSession> = {}): ConsensusSession {
  return {
    id: 'cs_login_plan',
    blockId: 'task_login',
    executionId: 'exec_login',
    stepIndex: 0,
    agentKind: 'architect',
    strategy: 'debate',
    status: 'done',
    groupName: 'Risky changes',
    participants: [
      { id: 'p_pragmatist', role: 'Pragmatist', modelId: 'claude-opus' },
      { id: 'p_security', role: 'Security reviewer', modelId: 'kimi-k2.7' },
    ],
    rounds: [
      {
        index: 0,
        kind: 'draft',
        contributions: [
          {
            participantId: 'p_pragmatist',
            text: 'Rotate on every refresh and keep the old token valid for 30 seconds.',
          },
          {
            participantId: 'p_security',
            text: 'Rotate on every refresh. **No grace window**: a reused token revokes the family.',
          },
        ],
      },
      {
        index: 1,
        kind: 'critique',
        contributions: [
          {
            participantId: 'p_pragmatist',
            text: 'Expert B is right that a grace window hides theft. Without it, two tabs refreshing at once log the user out.',
            scores: [
              { dimension: 'safety', value: 0.6 },
              { dimension: 'usability', value: 0.85 },
            ],
          },
          {
            participantId: 'p_security',
            text: 'A per-family lock solves the two-tab case without a window.',
            scores: [
              { dimension: 'safety', value: 0.9 },
              { dimension: 'usability', value: 0.75 },
            ],
          },
        ],
      },
    ],
    synthesis:
      'Rotate the refresh token on every use, behind a per-family lock. A reused token revokes ' +
      'the whole family. No grace window.',
    confidence: 0.82,
    dissent: ['The lock adds a Redis round trip to every refresh.'],
    createdAt: Date.UTC(2026, 9, 11, 9, 0),
    updatedAt: Date.UTC(2026, 9, 11, 9, 6),
    ...overrides,
  }
}

function sessionIs(body: ConsensusSession | null) {
  return apiResponse(getConsensusSessionContract, {
    pathPrefix: storyWorkspacePrefix,
    pathParams: { blockId: 'task_login' },
    body: { session: body },
  })
}

const meta = {
  title: 'Pipeline/Pages/ConsensusSessionWindow',
  component: ConsensusSessionWindow,
  parameters: { api: [sessionIs(session())] },
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot({ executions: [execution()] }))
      seedModelCatalog(claudeOnlyCatalog)
      seedResultView({
        view: 'consensus-session',
        blockId: 'task_login',
        instanceId: 'exec_login',
        stepIndex: 0,
      })
    }),
  ],
} satisfies Meta<typeof ConsensusSessionWindow>
export default meta

type Story = StoryObj<typeof meta>

/** A finished debate: the combined result at 82%, one dispute, the panel and both rounds. */
export const Default: Story = {}

/** The session read in flight: placeholder blocks. */
export const Loading: Story = {
  parameters: {
    api: [
      apiPending(getConsensusSessionContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { blockId: 'task_login' },
      }),
    ],
  },
}

/** The task has no session. */
export const Empty: Story = { parameters: { api: [sessionIs(null)] } }

/** Still debating: the first round only, and no result yet. */
export const Running: Story = {
  parameters: {
    api: [
      sessionIs(
        session({
          status: 'running',
          rounds: session().rounds.slice(0, 1),
          synthesis: null,
          confidence: null,
          dissent: [],
        }),
      ),
    ],
  },
}

/** The session failed: the reason, with a copy button. The provider error is made up. */
export const SessionFailed: Story = {
  parameters: {
    api: [
      sessionIs(
        session({
          status: 'failed',
          synthesis: null,
          confidence: null,
          dissent: [],
          error: 'Participant p_security: the model provider answered 429 (rate limited).',
        }),
      ),
    ],
  },
}

/**
 * The read failed. The store drops every load error, so the window shows the empty state, the
 * same as a task with no session.
 */
export const Failed: Story = {
  parameters: {
    api: [
      apiFailure(getConsensusSessionContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { blockId: 'task_login' },
      }),
    ],
  },
}
