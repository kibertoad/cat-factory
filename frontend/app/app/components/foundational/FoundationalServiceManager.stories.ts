import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent } from 'storybook/test'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { foundationalApi } from '~/stories/foundationalApi'
import {
  accountServices,
  foundationalSources,
  resolvedCatalog,
  serviceCatalogConnection,
  suppressions,
  workspaceServices,
} from '~/stories/foundational.stories.mocks'
import { githubProbeApi } from '~/stories/githubApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import FoundationalServiceManager from './FoundationalServiceManager.vue'

// The foundational services of one owner, a board or an account: the shared capabilities the
// organisation already runs, which an architect designs against. A board's opens on the catalog
// its agents are handed (every tier merged, with what the board hides), then its own services,
// the repositories they sync from and its developer portal. An account has no catalog and no
// portal. The manager loads the owner's catalog and probes GitHub when it opens, so each story
// answers those reads. The tabs are clicked, as a person does. Each section's own states are in
// its own stories.

/** The shared sources, linked by the board in place of the account. */
const boardSources = foundationalSources.map((s) => ({
  ...s,
  ownerKind: 'workspace' as const,
  ownerId: STORY_WORKSPACE_ID,
}))

async function openTab(name: string) {
  await userEvent.click(await screen.findByRole('tab', { name }))
}

const meta = {
  title: 'Settings/Components/FoundationalServiceManager',
  component: FoundationalServiceManager,
  args: { kind: 'workspace', ownerId: STORY_WORKSPACE_ID, showCatalog: true },
  decorators: [withSeed(seedWorkspace)],
  parameters: {
    width: 'prose',
    api: [
      ...foundationalApi('workspace', {
        services: workspaceServices,
        resolved: resolvedCatalog,
        suppressions,
        sources: boardSources,
        serviceCatalog: serviceCatalogConnection(),
      }),
      ...githubProbeApi(),
    ],
  },
} satisfies Meta<typeof FoundationalServiceManager>
export default meta

type Story = StoryObj<typeof meta>

/** The board's catalog: four services from three tiers, and the two the board hides. */
export const Default: Story = {}

/**
 * The account's own services, and under them the list of what the account hides (empty here),
 * since an account has no catalog tab to put that list beside.
 */
export const Account: Story = {
  args: { kind: 'account', ownerId: orgAccount.id, showCatalog: false },
  parameters: {
    api: [
      ...foundationalApi(
        { accountId: orgAccount.id },
        { services: accountServices, sources: foundationalSources },
      ),
      ...githubProbeApi(),
    ],
  },
}

/** The board's repositories: a directory of services, synced, and a billing API not synced yet. */
export const Sources: Story = {
  play: async () => {
    await openTab('Repo sources')
    await screen.findByTestId('foundational-sources')
  },
}

/** The board's Backstage, imported in full, with the form that replaces the connection. */
export const Portal: Story = {
  play: async () => {
    await openTab('Developer portal')
    await screen.findByTestId('service-catalog-connected')
  },
}

/** The catalog read failed, which the manager reads as the feature being off: a note only. */
export const Unavailable: Story = {
  parameters: {
    api: [...foundationalApi('workspace', { available: false }), ...githubProbeApi()],
  },
}
