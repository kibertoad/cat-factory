import type { Meta, StoryObj } from '@storybook/vue3'
import type { InfraSetup } from '@cat-factory/contracts'
import { screen, userEvent, within } from 'storybook/test'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useWorkspaceStore } from '~/stores/workspace'
import InfraSetupBanner from './InfraSetupBanner.vue'

// The board's cards for infrastructure the deployment needs and does not have: an agent runner,
// test environments, content storage. A card that was never set up is amber, with a link to set
// it up. One that is set up but does not answer is red, with the probe's reason when this
// session saw it fail. Each card shows only to someone who can fix it; a person who cannot, and
// whose runs it stops, sees one line instead. Close opens a menu: hide for this session, or never
// again for a setup gap.
//
// The status is the snapshot's `infraSetup`, seeded here. "Never again" is stored in the
// browser, so no story picks it. The outage reason is made up.
const configured: InfraSetup = {
  agentExecutor: 'configured',
  ephemeralEnvironments: 'configured',
  binaryStorage: 'configured',
}

function withStatus(status: InfraSetup) {
  return withSeed(() => {
    seedWorkspace()
    useWorkspaceStore().infraSetup = status
  })
}

const meta = {
  title: 'Setup/Components/InfraSetupBanner',
  component: InfraSetupBanner,
  decorators: [withStatus({ ...configured, ephemeralEnvironments: 'not_defined' })],
} satisfies Meta<typeof InfraSetupBanner>
export default meta

type Story = StoryObj<typeof meta>

/** No test environment provider set up: the amber card and its set-up button. */
export const Default: Story = {}

/** The runner pool is set up and stopped answering: the red card, with the probe's reason. */
export const Outage: Story = {
  decorators: [
    withSeed(() => {
      seedWorkspace()
      const workspace = useWorkspaceStore()
      workspace.infraSetup = configured
      workspace.patchInfraSetup(
        'agentExecutor',
        'unreachable',
        'connect ECONNREFUSED 10.0.4.12:443',
      )
    }),
  ],
}

/** Nothing set up: the three cards, the runner first because without it no agent runs. */
export const AllAreas: Story = {
  decorators: [
    withStatus({
      agentExecutor: 'not_defined',
      ephemeralEnvironments: 'not_defined',
      binaryStorage: 'not_defined',
    }),
  ],
}

/**
 * A member, who cannot set up a runner but whose runs need one: the one line, and no cards. The
 * missing test environment does not stop every run, so it shows nothing.
 */
export const Notice: Story = {
  decorators: [
    withStatus({
      ...configured,
      agentExecutor: 'not_defined',
      ephemeralEnvironments: 'not_defined',
    }),
    withSeed(() => {
      useWorkspaceStore().access = {
        role: 'member',
        permissions: ['workspace.read', 'board.write', 'runs.execute'],
      }
    }),
  ],
}

/** Close on a setup gap opens the two choices. */
export const DismissMenu: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByTestId('infra-setup-dismiss-ephemeralEnvironments'),
    )
    await screen.findByRole('menuitem', { name: /session/i })
  },
}
