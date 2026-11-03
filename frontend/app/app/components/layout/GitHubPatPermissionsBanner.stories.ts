import type { GitHubPatCapabilityReport, GitHubPatCheck } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { withSeed } from '~/stories/withStores'
import { useGitHubStore } from '~/stores/github'
import GitHubPatPermissionsBanner from './GitHubPatPermissionsBanner.vue'

// The warning that the GitHub token a run would use cannot do what a pipeline needs: push, or
// open pull requests. It names each missing capability, says whose token it is (the
// deployment's or the person's own), and links to GitHub's token page for the token's kind. A
// token GitHub refused gets its own title. Each story seeds the token check the snapshot carries.
function report(overrides: Partial<GitHubPatCapabilityReport> = {}): GitHubPatCapabilityReport {
  return {
    source: 'initiator',
    kind: 'classic',
    capabilities: { push: 'missing', pullRequests: 'missing', workflows: 'granted' },
    probedRepos: ['acme/auth-service'],
    deniedRepos: [],
    unprobedRepoCount: 0,
    webUrl: 'https://github.com',
    ...overrides,
  }
}

const withCheck = (check: GitHubPatCheck) =>
  withSeed(() => {
    useGitHubStore().patCheck = check
  })

const meta = {
  title: 'Setup/Components/GitHubPatPermissionsBanner',
  component: GitHubPatPermissionsBanner,
  decorators: [withCheck({ state: 'checked', report: report() })],
} satisfies Meta<typeof GitHubPatPermissionsBanner>
export default meta

type Story = StoryObj<typeof meta>

/** The person's own classic token without push or pull requests: the classic form button. */
export const Default: Story = {}

/**
 * A fine-grained token not granted two of the linked repositories, and without workflows. The
 * fine-grained form takes no prefill, so the permissions are named. Two of five repositories were
 * checked, and the card says so.
 */
export const FineGrained: Story = {
  decorators: [
    withCheck({
      state: 'checked',
      report: report({
        kind: 'fine_grained',
        capabilities: { push: 'missing', pullRequests: 'granted', workflows: 'missing' },
        probedRepos: ['acme/auth-service', 'acme/billing'],
        deniedRepos: ['acme/billing'],
        unprobedRepoCount: 3,
      }),
    }),
  ],
}

/** GitHub refused the person's token (401): the rejected title and body. */
export const Rejected: Story = {
  decorators: [withCheck({ state: 'token_rejected', status: 401, source: 'initiator' })],
}

/** The deployment's own token: the line that says whoever runs the deployment replaces it. */
export const DeploymentToken: Story = {
  decorators: [withCheck({ state: 'checked', report: report({ source: 'deployment' }) })],
}
