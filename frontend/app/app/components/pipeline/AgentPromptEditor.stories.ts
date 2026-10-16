import type { Meta, StoryObj } from '@storybook/vue3'
import type { AgentPromptDetail, AgentPromptRevision } from '@cat-factory/contracts'
import { getAgentPromptContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import AgentPromptEditor from './AgentPromptEditor.vue'

// The workspace's own system prompt for one agent kind, opened from the pipeline builder. It edits
// the shipped track prompt only: the platform appends its own rules to whatever is saved, and the
// editor shows that text on request. Every save adds a revision, and going back is one more, so
// nothing is lost. The output-token ceiling for the kind saves on its own. It loads the prompt
// when it opens, so each story answers that read.
//
// The coder runs the `build` track prompt, version 8 (`PROMPT_VERSIONS` in agents). The prompt
// texts here are short made-up stand-ins.
const builtinText =
  'You are a senior engineer implementing one task in an existing repository.\n' +
  'Read the plan, change only what the task needs, and keep the tests green.'
const customText = `${builtinText}\nPrefer small commits. Never touch the generated clients under sdk/.`
const appendedText =
  '## Delivery contract\nPush your work to the task branch. Do not open the pull request yourself.'

function revision(n: number, text: string | null, restoredFrom?: number): AgentPromptRevision {
  return {
    agentKind: 'coder',
    revision: n,
    text,
    ...(restoredFrom !== undefined ? { restoredFrom } : {}),
    createdAt: Date.UTC(2026, 9, 1 + n, 14),
  }
}

function detail(overrides: Partial<AgentPromptDetail> = {}): AgentPromptDetail {
  return {
    agentKind: 'coder',
    builtinText,
    builtinVersionLabel: 'build@v8',
    appendedText,
    effectiveText: customText,
    customized: true,
    revisions: [revision(3, customText, 1), revision(2, null), revision(1, customText)],
    ...overrides,
  }
}

function promptIs(body: AgentPromptDetail) {
  return apiResponse(getAgentPromptContract, {
    pathPrefix: storyWorkspacePrefix,
    pathParams: { agentKind: 'coder' },
    body,
  })
}

const meta = {
  title: 'Pipeline/Components/AgentPromptEditor',
  component: AgentPromptEditor,
  args: { agentKind: 'coder' },
  parameters: { api: [promptIs(detail())] },
  decorators: [withSeed(seedWorkspace)],
} satisfies Meta<typeof AgentPromptEditor>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The coder's prompt, customised: one edit, a revert to the built-in, and the edit restored, which
 * is live.
 */
export const Default: Story = {}

/** The prompt read in flight: placeholder blocks. */
export const Loading: Story = {
  parameters: {
    api: [
      apiPending(getAgentPromptContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { agentKind: 'coder' },
      }),
    ],
  },
}

/** Never edited: the built-in prompt, and Revert disabled. The history is empty. */
export const UsingBuiltin: Story = {
  parameters: {
    api: [promptIs(detail({ effectiveText: builtinText, customized: false, revisions: [] }))],
  },
}

/** No revision yet: the history says so. */
export const EmptyHistory: Story = {
  parameters: {
    api: [promptIs(detail({ effectiveText: builtinText, customized: false, revisions: [] }))],
  },
}

/** What the platform appends, opened. */
export const AppendedTextOpen: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: /show what/i }))
    await screen.findByText('Appended by the platform (not editable)')
  },
}

/** The built-in prompt shown beside the editor, for comparison. */
export const BuiltinShown: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: /compare with built-in/i }))
    await screen.findByText('Built-in prompt')
  },
}
