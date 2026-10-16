import type { Meta, StoryObj } from '@storybook/vue3'
import type { ForkChatMessage, ForkDecisionStepState } from '@cat-factory/contracts'
import { chooseForkContract, getForkDecisionContract } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen, userEvent } from 'storybook/test'
import { apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { forkChat, forkDecisionState } from '~/stories/forkDecision.stories.mocks'
import { approval, step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, seedViewer, withSeed } from '~/stories/withStores'
import ForkDecisionWindow from './ForkDecisionWindow.vue'

// Before the coder writes the login task, a read-only proposer offers materially different ways
// to do it. The window lists them as one choice with "my own approach" as the last option, takes
// an optional steering note, and has a chat about the approaches with a limited number of
// questions. Choose re-runs the coder with the pick. The window reads the decision off the run's
// coder step, so each story seeds the run; opening it also reads the decision again, answered
// with the same state. The approaches and the chat are made up (`forkDecision.stories.mocks.ts`);
// the refusal is the backend's (`ForkDecisionController`).
const params = { pathPrefix: storyWorkspacePrefix, pathParams: { executionId: 'exec_login' } }

function opened(state: ForkDecisionStepState | null, { viewer = false } = {}) {
  // The backend takes a choice only on a parked step of a blocked run (`ForkDecisionController`).
  const parked = state?.status === 'awaiting_choice' || state?.status === 'answering'
  const run = execution({
    status: parked ? 'blocked' : 'running',
    steps: [
      step({ agentKind: 'architect', state: 'done', progress: 1 }),
      step({
        agentKind: 'coder',
        state: parked ? 'waiting_decision' : 'working',
        progress: 0.1,
        ...(state ? { forkDecision: state } : {}),
        ...(parked
          ? { approval: approval({ id: 'appr_login_fork', proposal: 'Pick an approach.' }) }
          : {}),
      }),
      step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
    ],
  })
  return withSeed(() => {
    seedSnapshot(snapshot({ executions: [run] }))
    seedResultView({
      view: 'fork-decision',
      blockId: run.blockId,
      instanceId: run.id,
      stepIndex: 1,
    })
    if (viewer) seedViewer()
  })
}

function reads(state: ForkDecisionStepState | null): HttpHandler[] {
  return [apiResponse(getForkDecisionContract, { ...params, body: state })]
}

const waiting = forkDecisionState()

/** A second question, after the one in `forkChat`. */
const denyListQuestion: ForkChatMessage = {
  id: 'fmsg_3',
  role: 'human',
  text: 'How long does the deny list approach keep a used token?',
  createdAt: Date.UTC(2026, 9, 12, 10, 3),
}

const proposing = forkDecisionState({ status: 'proposing', forks: [], seamSummary: null })

const singlePath = forkDecisionState({
  status: 'single_path',
  forks: [],
  singlePathReason:
    'The repository already rotates API keys with a token family table; refresh tokens follow ' +
    'the same pattern.',
})

const chosen = forkDecisionState({
  status: 'chosen',
  chat: forkChat,
  chosen: {
    forkId: 'fork_session_service',
    note: 'Keep the migration reversible.',
    at: Date.UTC(2026, 9, 12, 10, 6),
  },
})

const answering = forkDecisionState({
  status: 'answering',
  chat: [...forkChat, denyListQuestion],
})

const budgetSpent = forkDecisionState({
  maxChatTurns: 2,
  chat: [
    ...forkChat,
    denyListQuestion,
    {
      id: 'fmsg_4',
      role: 'assistant',
      text: 'Until the token expires: the TTL is the refresh token lifetime, 30 days.',
      createdAt: Date.UTC(2026, 9, 12, 10, 4),
    },
  ],
})

/** Scroll the chat into view: it is below the approaches. */
async function showChat() {
  ;(await screen.findByTestId('fork-chat-input')).scrollIntoView({ block: 'end' })
}

const meta = {
  title: 'Pipeline/Pages/ForkDecisionWindow',
  component: ForkDecisionWindow,
} satisfies Meta<typeof ForkDecisionWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Three approaches, the session service one recommended and picked, then "my own approach". The
 * chat has no question yet.
 */
export const Default: Story = {
  decorators: [opened(waiting)],
  parameters: { api: reads(waiting) },
}

const skipped = forkDecisionState({ status: 'skipped', forks: [], seamSummary: null })

/** The step skipped the decision (the estimate was below the gate): nothing to decide. */
export const Empty: Story = {
  decorators: [opened(skipped)],
  parameters: { api: reads(skipped) },
}

/** The proposer is still reading the repository. */
export const Proposing: Story = {
  decorators: [opened(proposing)],
  parameters: { api: reads(proposing) },
}

/** The proposer found one sensible way, so the coder runs without a choice. */
export const SinglePath: Story = {
  decorators: [opened(singlePath)],
  parameters: { api: reads(singlePath) },
}

/** Decided: the record of the pick and the steering note. */
export const Chosen: Story = {
  decorators: [opened(chosen)],
  parameters: { api: reads(chosen) },
}

/** A second question was sent, and the answer is on its way. */
export const Answering: Story = {
  decorators: [opened(answering)],
  parameters: { api: reads(answering) },
  play: async () => {
    await showChat()
    await screen.findByText('Thinking…')
  },
}

/** The chat has used both of its questions: the box is off and says so. */
export const ChatBudgetSpent: Story = {
  decorators: [opened(budgetSpent)],
  parameters: { api: reads(budgetSpent) },
  play: async () => {
    await showChat()
    await screen.findByPlaceholderText(/Chat limit reached/)
  },
}

/** The pick was refused, because the run moved on: the refusal shows above the approaches. */
export const Error: Story = {
  decorators: [opened(waiting)],
  parameters: {
    api: [
      apiRefusal(chooseForkContract, {
        ...params,
        status: 409,
        error: {
          code: 'conflict',
          message: 'The run is no longer awaiting an implementation-fork choice',
        },
      }),
      ...reads(waiting),
    ],
  },
  play: async () => {
    await userEvent.click(await screen.findByTestId('fork-option-choose'))
    await screen.findByText(/no longer awaiting/)
  },
}

/** A board viewer reads the approaches and the chat; Choose and Send are off. */
export const Viewer: Story = {
  decorators: [opened(forkDecisionState({ chat: forkChat }), { viewer: true })],
  parameters: { api: reads(forkDecisionState({ chat: forkChat })) },
  play: async () => {
    await showChat()
    await screen.findAllByTitle(/Read-only access/)
  },
}
