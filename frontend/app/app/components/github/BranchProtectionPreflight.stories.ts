import type { Meta, StoryObj } from '@storybook/vue3'
import type { BranchProtectionReportView } from '@cat-factory/contracts'
import { checkGitHubBranchProtectionContract } from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import BranchProtectionPreflight from './BranchProtectionPreflight.vue'

// Whether each linked repository's default branch is protected on GitHub: the one control that
// stops a stolen push credential from writing to main, and one the platform cannot provide. It
// checks only when asked, because each repository costs live GitHub reads, so every story but
// Idle clicks Check and answers the report. Unprotected repositories sort first, then the ones
// GitHub would not say about. The repositories are made up.
type Row = BranchProtectionReportView['repos'][number]

function repo(id: number, name: string, protection: Row['protection']): Row {
  return { repoGithubId: id, owner: 'acme', name, defaultBranch: 'main', protection }
}

const protectedWithPr = repo(101, 'auth-service', {
  state: 'protected',
  detail: {
    requiresPullRequest: true,
    requiredApprovingReviewCount: 1,
    requiredStatusChecks: ['ci / test', 'ci / lint'],
    allowsForcePush: false,
  },
})

function reportIs(report: BranchProtectionReportView) {
  return apiResponse(checkGitHubBranchProtectionContract, {
    pathPrefix: storyWorkspacePrefix,
    body: report,
  })
}

async function check(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByTestId('branch-protection-check'))
}

const meta = {
  title: 'Settings/Components/BranchProtectionPreflight',
  component: BranchProtectionPreflight,
  decorators: [withSeed(seedWorkspace)],
  parameters: {
    width: 'prose',
    api: [
      reportIs({
        capability: 'ok',
        omittedRepos: 0,
        repos: [
          protectedWithPr,
          repo(102, 'api-gateway', { state: 'unprotected' }),
          repo(734_102, 'platform', { state: 'unknown', reason: 'forbidden' }),
          repo(104, 'web-app', { state: 'protected', detailUnavailable: 'forbidden' }),
        ],
      }),
    ],
  },
  play: async ({ canvasElement }) => check(canvasElement),
} satisfies Meta<typeof BranchProtectionPreflight>
export default meta

type Story = StoryObj<typeof meta>

/**
 * One repository exposed, first; one GitHub would not answer for; one protected whose rule could
 * not be read; and one that requires a reviewed pull request and two checks.
 */
export const Default: Story = {}

/** Before anyone asks: only the Check button. */
export const Idle: Story = { play: async () => {} }

/** The check in flight: the button spins. */
export const Loading: Story = {
  parameters: {
    api: [apiPending(checkGitHubBranchProtectionContract, { pathPrefix: storyWorkspacePrefix })],
  },
}

/** Every repository protected. */
export const AllProtected: Story = {
  parameters: { api: [reportIs({ capability: 'ok', omittedRepos: 0, repos: [protectedWithPr] })] },
}

/** The provider cannot answer the question at all: said, rather than shown as an empty list. */
export const Unavailable: Story = {
  parameters: { api: [reportIs({ capability: 'unavailable', omittedRepos: 0, repos: [] })] },
}

/** The report stopped at its cap: a line says how many repositories it left out. */
export const Omitted: Story = {
  parameters: {
    api: [reportIs({ capability: 'ok', omittedRepos: 37, repos: [protectedWithPr] })],
  },
}

/** The check failed: a translated line, with the backend's words and the request id behind Show detail. */
export const Error: Story = {
  parameters: {
    api: [apiFailure(checkGitHubBranchProtectionContract, { pathPrefix: storyWorkspacePrefix })],
  },
}
