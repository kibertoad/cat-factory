import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { block } from '~/stories/block.stories.mocks'
import { withBoard } from '~/stories/withStores'
import ServiceConnections from './ServiceConnections.vue'

// Which other services this one uses, and, read-only below, which services use it. The rows come
// off the block; the provider picker and the "Used by" list come from the other service frames
// on the board, so the stories seed `useBoardStore`. A provider named in one row is left out of
// the other rows' pickers, and the add button disables when no provider is left.
const auth = block({
  id: 'svc_auth',
  title: 'Auth Service',
  type: 'service',
  level: 'frame',
  parentId: null,
})

const others = [
  block({ id: 'svc_api', title: 'API Gateway', type: 'service', level: 'frame', parentId: null }),
  block({ id: 'svc_db', title: 'Core Database', type: 'service', level: 'frame', parentId: null }),
  block({
    id: 'svc_queue',
    title: 'Notification Queue',
    type: 'service',
    level: 'frame',
    parentId: null,
  }),
]

/** A frame that names `svc_auth` as a provider, which is what puts it in "Used by". */
const consumer = block({
  id: 'svc_web',
  title: 'Web Frontend',
  type: 'service',
  level: 'frame',
  parentId: null,
  serviceConnections: [{ serviceBlockId: 'svc_auth', description: 'Signs users in.' }],
})

const meta = {
  title: 'Inspector/Components/ServiceConnections',
  component: ServiceConnections,
  parameters: { width: 'panel' },
  decorators: [withBoard([auth, ...others, consumer])],
  // `InspectorSection` opens CLOSED, which is right in a panel of a dozen sections and useless in
  // a story: every one would be a titled bar. Opening it is a play rather than a prop because the
  // section owns its own `open` model and a caller cannot set it.
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('inspector-section-toggle'))
  },
} satisfies Meta<typeof ServiceConnections>
export default meta

type Story = StoryObj<typeof meta>

/** Two providers named, one consumer naming this service back. */
export const Default: Story = {
  args: {
    block: block({
      ...auth,
      serviceConnections: [
        { serviceBlockId: 'svc_db', description: 'Reads and writes the session table.' },
        { serviceBlockId: 'svc_queue' },
      ],
    }),
  },
}

/** No connections yet: the empty state, with the add button enabled. */
export const Empty: Story = { args: { block: auth } }

/** Every other frame is already named, so the add button is disabled. */
export const AllTaken: Story = {
  args: {
    block: block({
      ...auth,
      serviceConnections: [
        { serviceBlockId: 'svc_api' },
        { serviceBlockId: 'svc_db' },
        { serviceBlockId: 'svc_queue' },
        { serviceBlockId: 'svc_web' },
      ],
    }),
  },
}

/** The only frame on the board: the empty state, a disabled add button, no "Used by". */
export const Alone: Story = {
  args: { block: auth },
  decorators: [withBoard([auth])],
}
