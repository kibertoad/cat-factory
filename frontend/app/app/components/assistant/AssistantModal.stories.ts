import type { Meta, StoryObj } from '@storybook/vue3'
import {
  ASSISTANT_ACTION_IDS,
  getAssistantCapabilityContract,
  runAssistantTurnContract,
  type AssistantActionId,
  type AssistantTurn,
} from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import AssistantModal from './AssistantModal.vue'

// The assistant: one prompt box, and the outcome of the turn under it. Each open reads what the
// deployment's assistant can do; the box shows once that read answers with actions, and a panel
// takes its place when there is no model, no action, or no answer. The outcome stories type a
// request, click Run and answer the turn. The services and turns are made up.
const capability = (actions: AssistantActionId[]) =>
  apiResponse(getAssistantCapabilityContract, {
    pathPrefix: storyWorkspacePrefix,
    body: { available: true, actions },
  })

const turn = (outcome: AssistantTurn['outcome']) =>
  apiResponse(runAssistantTurnContract, {
    pathPrefix: storyWorkspacePrefix,
    body: { outcome, model: { provider: 'anthropic', model: 'claude-haiku-5-5' } },
  })

const meta = {
  title: 'Shell/Components/AssistantModal',
  component: AssistantModal,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useUiStore().openAssistant()
    }),
  ],
  parameters: { api: [capability([...ASSISTANT_ACTION_IDS])] },
} satisfies Meta<typeof AssistantModal>
export default meta

type Story = StoryObj<typeof meta>

/** Type a request once the capability read has answered, and run it. */
async function ask() {
  await screen.findByText('What you can ask')
  await userEvent.type(screen.getByRole('textbox'), 'the API gateway depends on auth')
  await userEvent.click(screen.getByRole('button', { name: 'Run' }))
  await screen.findByTestId('assistant-outcome')
}

/** The box, with one example per action the deployment offers. */
export const Default: Story = {}

/** The capability read in flight: the box takes typing, and Run waits with the reason beside it. */
export const Loading: Story = {
  parameters: {
    api: [apiPending(getAssistantCapabilityContract, { pathPrefix: storyWorkspacePrefix })],
  },
}

/** The capability read failed: a panel with Retry in place of the box. */
export const Error: Story = {
  parameters: {
    api: [apiFailure(getAssistantCapabilityContract, { pathPrefix: storyWorkspacePrefix })],
  },
}

/** No model on the deployment: a panel that says so. */
export const Unwired: Story = {
  parameters: {
    api: [
      apiResponse(getAssistantCapabilityContract, {
        pathPrefix: storyWorkspacePrefix,
        body: { available: false, actions: [] },
      }),
    ],
  },
}

/** A model and no actions: a panel that says so. */
export const NoActions: Story = { parameters: { api: [capability([])] } }

/** A request over the limit: Run is off, and the line beside it gives both lengths. */
export const TooLong: Story = {
  play: async () => {
    await screen.findByText('What you can ask')
    await userEvent.click(screen.getByRole('textbox'))
    await userEvent.paste(
      'the checkout service depends on the payments service, '.repeat(40).trim(),
    )
    await screen.findByText(/and the assistant reads up to/)
  },
}

/** A dependency declared: the result line names both services, with Show on board. */
export const Performed: Story = {
  parameters: {
    api: [
      capability([...ASSISTANT_ACTION_IDS]),
      turn({
        status: 'performed',
        result: {
          actionId: 'declare-service-dependency',
          consumer: { blockId: 'svc_gateway', title: 'API Gateway' },
          provider: { blockId: 'svc_auth', title: 'Auth Service' },
          created: true,
        },
      }),
    ],
  },
  play: ask,
}

/** Two services match "auth": the question, and one chip per candidate that answers it. */
export const NeedsInput: Story = {
  parameters: {
    api: [
      capability([...ASSISTANT_ACTION_IDS]),
      turn({
        status: 'needs_input',
        actionId: 'declare-service-dependency',
        reason: 'ambiguous_service',
        field: 'provider',
        candidates: ['Auth Service', 'Auth Admin'],
        arguments: { consumer: 'API Gateway', provider: 'auth' },
      }),
    ],
  },
  play: ask,
}

/** Nothing in the catalog matches: the outcome lists what the assistant can do. */
export const Declined: Story = {
  parameters: {
    api: [
      capability([...ASSISTANT_ACTION_IDS]),
      turn({ status: 'declined', reason: 'no_matching_action' }),
    ],
  },
  play: ask,
}
