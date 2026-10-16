import type { Meta, StoryObj } from '@storybook/vue3'
import type { SharedStack } from '@cat-factory/contracts'
import { screen, userEvent, within } from 'storybook/test'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useSharedStacksStore } from '~/stores/sharedStacks'
import SharedStacksPanel from './SharedStacksPanel.vue'

// Long-lived compose stacks (databases, queues, a mail catcher) a board starts once and every
// run's environment joins: each with its status, its repository and the networks it manages,
// with Start or Stop, edit and remove; and the form that adds one, which can read the repository
// to fill the compose fields. Start and Stop drive a Docker daemon, so they work only on the local
// runtime. The stacks are seeded as the snapshot carries them; the repository and its files are
// made up.
function stack(overrides: Partial<SharedStack> & Pick<SharedStack, 'id' | 'name'>): SharedStack {
  return {
    workspaceId: STORY_WORKSPACE_ID,
    cloneUrl: 'https://github.com/acme/acme-shared-services.git',
    gitRef: 'main',
    composeFiles: ['docker-compose.yml'],
    composeProfiles: [],
    envFiles: [],
    managedNetworks: ['acme-shared'],
    setupSteps: [],
    prerequisites: [],
    healthGate: null,
    allowHostCommands: false,
    status: 'running',
    lastError: null,
    createdAt: Date.UTC(2026, 8, 12),
    updatedAt: Date.UTC(2026, 9, 12),
    ...overrides,
  }
}

const sharedServices = stack({
  id: 'stk_shared',
  name: 'acme-shared-services',
  composeProfiles: ['db', 'queue'],
  managedNetworks: ['acme-shared', 'acme-events'],
})

function seeded(stacks: SharedStack[]) {
  return withSeed(() => {
    seedWorkspace()
    useSharedStacksStore().hydrate(stacks)
  })
}

const meta = {
  title: 'Settings/Components/SharedStacksPanel',
  component: SharedStacksPanel,
  decorators: [seeded([sharedServices])],
  parameters: { width: 'prose' },
} satisfies Meta<typeof SharedStacksPanel>
export default meta

type Story = StoryObj<typeof meta>

/** One stack running, with its two networks and Stop; the add form under it. */
export const Default: Story = {}

/** No stack yet: the add form only. */
export const Empty: Story = { decorators: [seeded([])] }

/** A stack whose bring-up failed: the backend's error under it, and Start to try again. */
export const Failed: Story = {
  decorators: [
    seeded([
      stack({
        id: 'stk_shared',
        name: 'acme-shared-services',
        status: 'failed',
        lastError:
          'docker compose up exited 1: Bind for 0.0.0.0:5432 failed: port is already allocated',
      }),
    ]),
  ],
}

/**
 * Editing a stack whose layers include an inline document and a file from another repository:
 * the form lists the layers read-only, because it can author only in-repo paths.
 */
export const EditingAdvancedLayers: Story = {
  decorators: [
    seeded([
      stack({
        id: 'stk_mixed',
        name: 'search-stack',
        status: 'stopped',
        composeFiles: [
          'docker-compose.yml',
          { kind: 'inline', content: 'services:\n  mailpit:\n    image: axllent/mailpit\n' },
          { kind: 'repo', repo: 'acme/search-infra', path: 'compose/elastic.yml', ref: 'v3' },
        ],
      }),
    ]),
  ],
  play: async ({ canvasElement }) => {
    await userEvent.click(await screen.findByTestId('shared-stack-edit-stk_mixed'))
    await within(canvasElement).findByTestId('shared-stack-compose-layers')
  },
}
