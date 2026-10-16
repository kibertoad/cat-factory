import type { Meta, StoryObj } from '@storybook/vue3'
import type {
  ConnectionTestResult,
  UserSecretDescriptor,
  UserSecretStatus,
} from '@cat-factory/contracts'
import { listUserSecretsContract, testUserSecretContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import UserSecretsSection from './UserSecretsSection.vue'

// The signed-in user's own credentials, today a personal GitHub token: runs the user starts push
// with it, so the window asks for one, tests what it can reach, and warns when it reaches more
// than the deployment needs. The form is built from the descriptor the backend declares for the
// kind, and the window loads the user's secrets when it opens, so each story answers that read.
// The descriptor and the test verdicts are the backend's own (`userSecretKinds.ts` and
// `githubPatScope.ts` in integrations), for a classic token with the `repo` and `workflow`
// scopes.
const githubPat: UserSecretDescriptor = {
  kind: 'github_pat',
  label: 'GitHub personal access token',
  supportsTest: true,
  configFields: [
    {
      key: 'token',
      label: 'Personal access token',
      secret: true,
      required: true,
      placeholder: 'github_pat_… or ghp_…',
      help:
        'Runs you initiate use YOUR GitHub access (pushes, PR author, CI actor), so this token ' +
        "is the reach of every run you start. Prefer a fine-grained token limited to this deployment's repositories; test it to see what it grants.",
    },
  ],
}

const stored: UserSecretStatus = {
  kind: 'github_pat',
  label: 'Laptop token',
  hasSecret: true,
  connectedAt: Date.UTC(2026, 8, 14),
}

function secretsAre(secrets: UserSecretStatus[]) {
  return apiResponse(listUserSecretsContract, { body: { secrets, descriptors: [githubPat] } })
}

function testAnswers(result: ConnectionTestResult) {
  return apiResponse(testUserSecretContract, { pathParams: { kind: 'github_pat' }, body: result })
}

/**
 * Type a token and click Test once the stored token has loaded: the load resets the form when it
 * lands, so typing before it would be wiped. The stored token's row is the sign that it has.
 */
async function typeAndTest() {
  await screen.findByText('Laptop token')
  await userEvent.type(
    await screen.findByPlaceholderText('github_pat_… or ghp_…'),
    'ghp_story0000000000000000000000000000',
  )
  await userEvent.click(screen.getByRole('button', { name: 'Test connection' }))
}

const meta = {
  title: 'Settings/Components/UserSecretsSection',
  component: UserSecretsSection,
  decorators: [withSeed(() => useUiStore().openUserSecrets())],
  parameters: { api: [secretsAre([stored])] },
} satisfies Meta<typeof UserSecretsSection>
export default meta

type Story = StoryObj<typeof meta>

/** A token stored, with Remove, and the form that replaces it. */
export const Default: Story = {}

/** No token stored: the form that adds one. */
export const Empty: Story = { parameters: { api: [secretsAre([])] } }

/**
 * A replacement token tested: it passes as a classic token, with a warning that it reaches every
 * repository.
 */
export const TestPassed: Story = {
  parameters: {
    api: [
      secretsAre([stored]),
      testAnswers({
        ok: true,
        message: 'Authenticated as mlindqvist — classic token, scopes: repo, workflow',
        warnings: [
          {
            code: 'github_pat_classic_account_wide',
            message:
              "This classic token grants 'repo, workflow'. The 'repo' scope reaches every " +
              "repository you can push to — including ones this workspace's GitHub App was never " +
              'installed on — and runs you start will use it in preference to the App. Consider a ' +
              'fine-grained token limited to the repositories this deployment works on.',
          },
        ],
      }),
    ],
  },
  play: typeAndTest,
}

/** GitHub refuses the replacement token: the backend's verdict in red. */
export const TestFailed: Story = {
  parameters: {
    api: [
      secretsAre([stored]),
      testAnswers({ ok: false, message: 'GitHub rejected the token (HTTP 401)' }),
    ],
  },
  play: typeAndTest,
}
