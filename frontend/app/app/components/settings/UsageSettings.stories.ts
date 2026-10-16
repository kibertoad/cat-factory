import { getWorkspaceUsageContract } from '@cat-factory/contracts'
import type { UsageReport } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import UsageSettings from './UsageSettings.vue'

// This billing period's token use, in two sections: flat-rate subscriptions and metered API
// calls. Each row is one model, with a bar relative to the heaviest model in its section. Only the
// metered rows count toward the spend budget; subscription costs are illustrative. The panel
// loads the report when the workspace is set, so each story answers that request. The figures
// are made up.
const report: UsageReport = {
  periodStart: Date.UTC(2026, 9, 1),
  currency: 'EUR',
  rows: [
    {
      billing: 'subscription',
      vendor: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputTokens: 38_400_000,
      outputTokens: 2_150_000,
      costEstimate: 147.6,
      calls: 2_412,
    },
    {
      billing: 'subscription',
      vendor: 'glm',
      provider: 'zai',
      model: 'glm-5.2',
      inputTokens: 12_900_000,
      outputTokens: 880_000,
      costEstimate: 21.3,
      calls: 905,
    },
    {
      billing: 'metered',
      vendor: null,
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-5.2',
      inputTokens: 18_420_000,
      outputTokens: 2_910_000,
      costEstimate: 182.4,
      calls: 1_640,
    },
    {
      billing: 'metered',
      vendor: null,
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      inputTokens: 4_100_000,
      outputTokens: 610_000,
      costEstimate: 38.9,
      calls: 312,
    },
  ],
}

const reportIs = (body: UsageReport) =>
  apiResponse(getWorkspaceUsageContract, { pathPrefix: storyWorkspacePrefix, body })

const meta = {
  title: 'Settings/Components/UsageSettings',
  component: UsageSettings,
  parameters: { width: 'prose', api: [reportIs(report)] },
  decorators: [withSeed(seedWorkspace)],
} satisfies Meta<typeof UsageSettings>
export default meta

type Story = StoryObj<typeof meta>

/** Two subscription models and two metered models, each with its bar. */
export const Default: Story = {}

/** Nothing used this period: the empty state. */
export const Empty: Story = { parameters: { api: [reportIs({ ...report, rows: [] })] } }

/** The report has not answered: placeholder rows. */
export const Loading: Story = {
  parameters: {
    api: [apiPending(getWorkspaceUsageContract, { pathPrefix: storyWorkspacePrefix })],
  },
}

/** The report request failed: the error line. */
export const Failed: Story = {
  parameters: {
    api: [apiFailure(getWorkspaceUsageContract, { pathPrefix: storyWorkspacePrefix })],
  },
}
