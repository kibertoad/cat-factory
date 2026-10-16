import type { Meta, StoryObj } from '@storybook/vue3'
import { authService, boardBlocks, loginTask, sessionEpic } from '~/stories/board.stories.mocks'
import { inspectorApi } from '~/stories/inspectorApi'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { authServiceRow } from '~/stories/vcs.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import InspectorPanel from './InspectorPanel.vue'

// The panel that shows the block the user selected on the board: its title and description, the
// sections registered for its level, and its actions. It takes no props. It reads the selection
// from the UI store, so each story fills the stores from one workspace snapshot and then selects
// a block. The panel and its sections load data on mount; `inspectorApi` answers those requests.
//
// From `lg` up the panel sits in the board's top end corner, 320px wide, and its body scrolls.
// Below `lg` it is a bottom sheet. The "Acme compliance" section comes from this deployment's
// example module; its copy shows as raw i18n keys, in the running app too, because the
// deployment layer's messages are missing at runtime.
const blocks = boardBlocks.map((b) =>
  b.id === loginTask.id ? { ...b, executionId: 'exec_login' } : b,
)

const selecting = (id: string) =>
  withSeed(() => {
    seedSnapshot(snapshot({ blocks, executions: [execution()], serviceCatalog: [authServiceRow] }))
    useUiStore().select(id)
  })

const meta = {
  title: 'Inspector/Components/InspectorPanel',
  component: InspectorPanel,
  parameters: { layout: 'fullscreen', api: inspectorApi() },
  render: () => ({
    components: { InspectorPanel },
    template: '<div class="relative h-screen"><InspectorPanel /></div>',
  }),
} satisfies Meta<typeof InspectorPanel>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A task with a run of the build pipeline at the coder step. Its details are locked because the
 * run started, and Run becomes Re-run.
 */
export const Default: Story = { decorators: [selecting(loginTask.id)] }

/**
 * A service frame with its repo linked: the repo link, View requirements, Map service, its
 * modules and tasks, then the service sections. In the basic interface tier the release health
 * and testing context sections stay hidden until something is saved for them.
 */
export const ServiceFrame: Story = { decorators: [selecting(authService.id)] }

/**
 * An epic with four member tasks across two services, grouped by service and module. An epic
 * has no run, so there is no Run or Focus. Its delete button says "Delete service": the label
 * has no epic case and falls through to the service one.
 */
export const Epic: Story = { decorators: [selecting(sessionEpic.id)] }
