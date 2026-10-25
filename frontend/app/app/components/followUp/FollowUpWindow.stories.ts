import type { Meta, StoryObj } from '@storybook/vue3'
import {
  fileFollowUpContract,
  type FollowUpItem,
  type FollowUpsStepState,
} from '@cat-factory/contracts'
import { expect, screen, userEvent } from 'storybook/test'
import { apiRefusal } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, seedViewer, withSeed } from '~/stories/withStores'
import FollowUpWindow from './FollowUpWindow.vue'

// What the coder raised while it built the login task: follow-ups worth a later task, and
// questions only a person can answer. A follow-up is filed as an issue, sent back to the coder or
// dismissed; a question is answered (with another pass for the coder, or as a ruling that closes
// it) or dismissed. The steps after the coder wait until every item is decided. The window reads
// the items off the run's coder step, so each story seeds its own run. Every button sends a
// request no story answers, except File in `ActionFailed`.

const created = Date.UTC(2026, 9, 14, 10, 20)

function item(overrides: Partial<FollowUpItem> & Pick<FollowUpItem, 'id' | 'title'>): FollowUpItem {
  return {
    kind: 'follow_up',
    detail: '',
    status: 'pending',
    createdAt: created,
    updatedAt: created,
    ...overrides,
  }
}

const sessionStore = item({
  id: 'fu_session_store',
  title: 'Move the session store off the shared Redis',
  detail:
    'Sessions share a Redis instance with the rate limiter. A flush of one clears the other, ' +
    'which signs every user out.',
  suggestedAction: 'Give sessions their own Redis database, then migrate the keys.',
})

const lockout = item({
  id: 'fu_lockout_question',
  kind: 'question',
  title: 'Does a reused refresh token revoke every session of the user, or only that one?',
  detail: 'The plan says "revoke the session". A reused token can mean that the user is attacked.',
})

const clockSkew = item({
  id: 'fu_clock_skew',
  kind: 'question',
  title: 'How much clock skew should the token expiry allow?',
  detail: '',
})

/** The login run, with the coder's follow-up state on its coder step. */
function opened(state: FollowUpsStepState, seed: () => void = () => {}) {
  const run = execution({
    steps: [
      step({ agentKind: 'architect', state: 'done', progress: 1 }),
      step({ agentKind: 'coder', state: 'working', progress: 0.8, followUps: state }),
      step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
    ],
  })
  return withSeed(() => {
    seedSnapshot(snapshot({ executions: [run] }))
    seedResultView({ view: 'follow-ups', blockId: run.blockId, instanceId: run.id, stepIndex: 1 })
    seed()
  })
}

const pending: FollowUpsStepState = {
  enabled: true,
  items: [sessionStore, lockout, clockSkew],
  loops: 1,
  maxLoops: 3,
}

const meta = {
  title: 'Pipeline/Pages/FollowUpWindow',
  component: FollowUpWindow,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof FollowUpWindow>
export default meta

type Story = StoryObj<typeof meta>

/** One follow-up and two questions, none decided, after one of three passes. */
export const Default: Story = { decorators: [opened(pending)] }

/** The coder raised nothing. */
export const Empty: Story = {
  decorators: [opened({ enabled: true, items: [], loops: 0, maxLoops: 3 })],
}

/**
 * Every item decided: a follow-up filed as an issue, one sent back that the run ran out of passes
 * for, a question answered, one closed as a ruling, and one dismissed.
 */
export const Decided: Story = {
  decorators: [
    opened({
      enabled: true,
      loops: 3,
      maxLoops: 3,
      items: [
        {
          ...sessionStore,
          status: 'filed',
          ticketExternalId: 'AUTH-482',
          ticketUrl: 'https://acme.atlassian.net/browse/AUTH-482',
        },
        item({
          id: 'fu_audit_fields',
          title: 'Record the client IP on every session event',
          status: 'queued',
          sentToCoder: true,
          sendBackDropped: true,
        }),
        {
          ...lockout,
          status: 'answered',
          answer: 'Every session of the user. Then email them.',
        },
        { ...clockSkew, status: 'closed', answer: 'Thirty seconds. Do not ask again.' },
        item({
          id: 'fu_rename',
          title: 'Rename the session module to auth-session',
          status: 'dismissed',
        }),
      ],
    }),
  ],
}

/** A board viewer: the answer boxes take text, but no action is on, Dismiss included. */
export const ReadOnly: Story = {
  decorators: [opened(pending, seedViewer)],
  play: async () => {
    const dismiss = await screen.findAllByRole('button', { name: 'Dismiss' })
    // One per item: the follow-up's and each question's.
    await expect(dismiss).toHaveLength(pending.items.length)
    for (const button of dismiss) await expect(button).toBeDisabled()
  },
}

/**
 * File failed, because the workspace has no issue tracker: translated copy over the items, the
 * backend's reason behind "Show details".
 */
export const ActionFailed: Story = {
  decorators: [opened(pending)],
  parameters: {
    api: [
      apiRefusal(fileFollowUpContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { executionId: 'exec_login', itemId: sessionStore.id },
        status: 409,
        error: { code: 'conflict', message: 'No issue tracker is configured for this workspace' },
      }),
    ],
  },
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'File as issue' }))
    await screen.findByText('This action conflicts with the current state.')
    await userEvent.click(screen.getByTestId('failure-message-show-detail'))
    await screen.findByText(/No issue tracker is configured for this workspace/)
  },
}
