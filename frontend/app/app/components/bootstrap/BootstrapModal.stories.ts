import type { Meta, StoryObj } from '@storybook/vue3'
import type { BootstrapJob, ReferenceArchitecture } from '@cat-factory/contracts'
import { listGitHubInstallationsContract, startBootstrapJobContract } from '@cat-factory/contracts'
import { expect, screen, userEvent, waitFor } from 'storybook/test'
import { apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { bootstrapApi } from '~/stories/bootstrapApi'
import {
  awaitingReviewJob,
  referenceArchitectures,
  succeededNewRepoJob,
} from '~/stories/bootstrap.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { githubInstallations, vcsConnectOptions } from '~/stories/vcs.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useBootstrapStore } from '~/stores/bootstrap'
import { useUiStore } from '~/stores/ui'
import BootstrapModal from './BootstrapModal.vue'

// Bootstrap a new service: where it goes (a repository of its own, or a directory in a monorepo),
// how the work lands (a pull request, or straight on the default branch), where its content comes
// from (a reference architecture, or a prompt), and its name, role, description and visibility.
// Below the form, the recent runs and the reference architectures the workspace manages. Each open
// reads the architectures and the GitHub connection and repositories again, so every story answers
// those reads (`bootstrapApi`). The form's own state is not in a store, so the stories that need
// it filled click and type. The refusal is the backend's own wording; the runs are the shared
// fixtures.
//
// The architectures are seeded too, as an open after the first finds them in the store. On the
// first open of a session the list is empty when the form mounts, so the form switches to From
// scratch, and goes back to the reference default when the list arrives (First Open).
function opened({
  jobs = [],
  architectures = referenceArchitectures,
}: {
  jobs?: BootstrapJob[]
  architectures?: ReferenceArchitecture[]
} = {}) {
  return withSeed(() => {
    seedSnapshot(snapshot({ bootstrapJobs: jobs }))
    useBootstrapStore().architectures = architectures
    useUiStore().openBootstrap()
  })
}

const meta = {
  title: 'Setup/Components/BootstrapModal',
  component: BootstrapModal,
  decorators: [opened()],
  parameters: { api: bootstrapApi() },
} satisfies Meta<typeof BootstrapModal>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Paste a name into the name field: "Target repository name" for a new repository, "Service
 * name" in a monorepo. Pasted, not typed: in a monorepo the first keystroke seeds the directory,
 * which then keeps that one letter.
 */
async function enterName(name: string, label = 'Target repository name') {
  await userEvent.click(await screen.findByRole('textbox', { name: new RegExp(label) }))
  await userEvent.paste(name)
}

/**
 * A new repository from the Node service template, pushed straight to its default branch. Below,
 * a monorepo run waiting on its review and a finished one.
 */
export const Default: Story = {
  decorators: [opened({ jobs: [awaitingReviewJob(), succeededNewRepoJob()] })],
}

/**
 * Into a directory of the platform monorepo, as a pull request: the service name seeds the
 * directory, and the folder button beside it opens the repository's tree.
 */
export const IntoMonorepo: Story = {
  play: async () => {
    await userEvent.click(await screen.findByText('A directory in an existing monorepo'))
    await enterName('billing', 'Service name')
    // The picker shows once the repositories have loaded.
    await userEvent.click(await screen.findByRole('combobox', { name: /Monorepo/ }))
    await userEvent.click(await screen.findByRole('option', { name: 'acme/platform' }))
    await screen.findByTestId('bootstrap-directory-browse')
  },
}

/** From scratch: the prompt takes the place of the template, and is required. */
export const FromScratch: Story = {
  play: async () => {
    await userEvent.click(await screen.findByText('From scratch'))
    await screen.findByText('What should the bootstrapper build?')
  },
}

/** No reference architecture yet: the form starts from scratch, and the list below is empty. */
export const NoArchitectures: Story = {
  decorators: [opened({ architectures: [] })],
  parameters: { api: bootstrapApi({ architectures: [] }) },
}

/**
 * The first open of a session: the list is still empty when the form mounts, and the form goes
 * back to the reference default once the architectures load.
 */
export const FirstOpen: Story = {
  decorators: [opened({ architectures: [] })],
  play: async () => {
    const reference = await screen.findByRole('radio', { name: 'From a reference architecture' })
    await waitFor(() => expect(reference).toBeChecked())
  },
}

/** No architectures loaded, From scratch picked: the arriving list keeps that choice. */
export const FromScratchKeptOnLoad: Story = {
  decorators: [opened({ architectures: [] })],
  play: async () => {
    await userEvent.click(await screen.findByText('From scratch'))
    await waitFor(() => expect(useBootstrapStore().architectures).not.toHaveLength(0))
    await expect(screen.getByRole('radio', { name: 'From scratch' })).toBeChecked()
  },
}

/**
 * Reference picked by hand, then the list empties (From scratch is the only flow) and fills
 * again: the form goes back to the picked mode.
 */
export const PickedModeRestored: Story = {
  play: async () => {
    const reference = await screen.findByRole('radio', { name: 'From a reference architecture' })
    await userEvent.click(await screen.findByText('From scratch'))
    await userEvent.click(await screen.findByText('From a reference architecture'))
    const store = useBootstrapStore()
    const list = store.architectures
    store.architectures = []
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'From scratch' })).toBeChecked(),
    )
    store.architectures = list
    await waitFor(() => expect(reference).toBeChecked())
  },
}

/** Add opens the reference architecture form, with the repositories to pick a template from. */
export const ArchitectureForm: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }))
    // The repository picker shows only once the repositories have loaded.
    await screen.findByText(
      'Choose a repo you can access to fill in its owner and name, or enter them manually below.',
    )
  },
}

/** No repository host connected: the prompt and the ways to connect, and Launch stays off. */
export const NotConnected: Story = {
  parameters: {
    api: [
      ...bootstrapApi({
        connected: false,
        connectOptions: vcsConnectOptions.filter((o) => o.provider === 'github'),
      }),
      apiResponse(listGitHubInstallationsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: { installations: githubInstallations },
      }),
    ],
  },
}

/**
 * The launch was refused because the connection cannot see the template's repository: the alert
 * names it, offers to edit the entry, and the form keeps what was typed.
 */
export const ReferenceRefused: Story = {
  parameters: {
    api: [
      apiRefusal(startBootstrapJobContract, {
        pathPrefix: storyWorkspacePrefix,
        status: 422,
        error: {
          code: 'validation',
          message:
            'The reference architecture "Node service" points at acme/node-service-template, ' +
            "which this workspace's source-control connection cannot see. Either it names the " +
            'wrong repository, or the connection has not been granted access to it. Correct the ' +
            'reference architecture (or grant it access) and launch again: nothing has been ' +
            'created.',
          details: {
            reason: 'reference_repo_not_found',
            referenceArchitectureId: 'ref_node_service',
            referenceArchitectureName: 'Node service',
            repo: 'acme/node-service-template',
          },
        },
      }),
      ...bootstrapApi(),
    ],
  },
  play: async () => {
    await enterName('payments-service')
    await userEvent.click(screen.getByRole('button', { name: 'Bootstrap repo' }))
    await screen.findByTestId('bootstrap-reference-refusal')
  },
}
