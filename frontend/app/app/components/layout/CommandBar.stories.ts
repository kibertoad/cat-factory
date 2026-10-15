import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent } from 'storybook/test'
import { slackConnection } from '~/stories/integrations.stories.mocks'
import { shellProbeApi } from '~/stories/shellApi'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useSlackStore } from '~/stores/slack'
import { useUiRoleStore } from '~/stores/uiRole'
import { useUiStore } from '~/stores/ui'
import CommandBar from './CommandBar.vue'

// The command palette (Cmd+K or Ctrl+K): every create, integration, board and account command in
// groups, narrowed by the search box and run with the keyboard. The board's navigation registry
// supplies the destinations; the integration commands depend on what the board has connected,
// and each open probes four of them again, so every story answers the shell's probes. Slack is
// not among the four: the palette shows its command only once the sidebar has probed it, so the
// seed fills the Slack store as that probe would. The board is the shared one, with GitHub, Slack,
// Confluence, Figma and Jira connected. The security dashboard's raw key and the two external
// tools come from the example module this deployment registers.
const meta = {
  title: 'Shell/Components/CommandBar',
  component: CommandBar,
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot())
      const slack = useSlackStore()
      slack.available = true
      slack.connection = slackConnection
      useUiStore().openCommandBar()
    }),
  ],
  parameters: { api: shellProbeApi() },
} satisfies Meta<typeof CommandBar>
export default meta

type Story = StoryObj<typeof meta>

async function search(query: string) {
  await userEvent.type(await screen.findByPlaceholderText('Search or run a command…'), query)
}

/** Every group, with a manage or connect command for each integration. */
export const Default: Story = {}

/** "jira" typed: the commands whose label, group or keywords match. */
export const Filtered: Story = { play: () => search('jira') }

/** A query nothing matches: the empty state. */
export const NoResults: Story = { play: () => search('kubernetes cluster') }

/**
 * The designer role, which brings work in and does not configure the platform: the integration
 * commands go, and so do the destinations the role does not keep.
 */
export const IntakeRole: Story = {
  decorators: [withSeed(() => useUiRoleStore().setRole('designer'))],
}
