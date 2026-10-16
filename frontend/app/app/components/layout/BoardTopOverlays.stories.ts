import type { Meta, StoryObj } from '@storybook/vue3'
import { modelPreset } from '~/stories/policies.stories.mocks'
import { claudeOnlyCatalog, spendStatus } from '~/stories/providers.stories.mocks'
import { providerProbeApi } from '~/stories/setupApi'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedModelCatalog, seedSnapshot, withSeed } from '~/stories/withStores'
import { useModelPresetsStore } from '~/stores/modelPresets'
import { useWorkspaceStore } from '~/stores/workspace'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'
import BoardTopOverlays from './BoardTopOverlays.vue'

// The region over the top of the board: the toolbar first, then the advisory banners in a fixed
// order, the most urgent first, and the menu button that opens the navigation below the lg width.
// Each banner reads its own stores and shows only when it has something to say, so each story
// seeds a loaded board (`ready`) and the states that make the banners show. On a loaded board the
// provider banner asks both providers to describe themselves (`providerProbeApi`), and the default
// test environment banner shows until the board picks a type, so the quiet stories pick one. The
// two local mode GitHub token banners are their own stories. The page owns the live stream, so the
// connection state is the props.

/** A loaded board, with the board's test environment type picked unless `pickedTestEnv` is off. */
function board(seed: () => void = () => {}, { pickedTestEnv = true } = {}) {
  return withSeed(() => {
    seedSnapshot(snapshot())
    const workspace = useWorkspaceStore()
    workspace.ready = true
    workspace.spend = spendStatus({ costSpent: 182.4 })
    if (pickedTestEnv) {
      const settings = useWorkspaceSettingsStore()
      settings.settings = { ...settings.settings, defaultProvisionType: 'kubernetes' }
    }
    seed()
  })
}

const meta = {
  title: 'Board/Pages/BoardTopOverlays',
  component: BoardTopOverlays,
  args: { connected: true, everConnected: true, connectionFailed: false },
  parameters: { layout: 'fullscreen', api: providerProbeApi() },
} satisfies Meta<typeof BoardTopOverlays>
export default meta

type Story = StoryObj<typeof meta>

/** A connected board with nothing to report: the toolbar alone. */
export const Default: Story = { decorators: [board()] }

/**
 * Six advisories at once, in their order under the toolbar: no connection yet, the budget spent,
 * no model the board can run, the test environment provider without its token, no test
 * environments set up, and no default test environment type.
 */
export const StackedAdvisories: Story = {
  args: { connected: false, everConnected: false, connectionFailed: true },
  decorators: [
    board(
      () => {
        const workspace = useWorkspaceStore()
        workspace.spend = spendStatus({ costSpent: 503.8, costLimit: 500, exceeded: true })
        workspace.infraSetup = {
          agentExecutor: 'configured',
          ephemeralEnvironments: 'not_defined',
          binaryStorage: 'configured',
        }
        seedModelCatalog(claudeOnlyCatalog.map((m) => ({ ...m, available: false })))
        useModelPresetsStore().hydrate([modelPreset()])
      },
      { pickedTestEnv: false },
    ),
  ],
  parameters: { api: providerProbeApi({ environmentMissing: ['apiToken'] }) },
}

/** The live stream never connected: the offline pill under the toolbar. */
export const Disconnected: Story = {
  args: { connected: false, everConnected: false, connectionFailed: true },
  decorators: [board()],
}

/** The queue view's placement: in the page flow, with no toolbar, which is the canvas's own. */
export const InFlow: Story = {
  args: { inFlow: true },
  decorators: [
    board(() => {
      useWorkspaceStore().spend = spendStatus({ costSpent: 503.8, costLimit: 500, exceeded: true })
    }),
  ],
}
