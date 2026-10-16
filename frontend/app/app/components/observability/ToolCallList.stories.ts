import type { Meta, StoryObj } from '@storybook/vue3'
import { ref } from 'vue'
import { userEvent, within } from 'storybook/test'
import { loginToolCalls, loginToolFailures } from '~/stories/observability.stories.mocks'
import ToolCallList from './ToolCallList.vue'

// The tool calls a run's agents made, oldest first: each row names the tool, how long it took and
// whether it failed, and opens to its arguments and result. The chips count from the run-level
// failure read, never from the loaded rows, because the trajectory is a bounded prefix of the
// run; narrowing to Failed shows that read's failing calls. The filter is a `v-model`, so the
// stories keep it in a local ref. The coder's session is the shared one
// (`observability.stories.mocks.ts`).
const meta = {
  title: 'Run telemetry/Components/ToolCallList',
  component: ToolCallList,
  args: {
    trajectory: { toolCalls: [], truncated: false },
    failures: null,
    loading: false,
    error: null,
    failuresLoading: false,
    failuresError: null,
    filter: 'all',
  },
  render: (args) => ({
    components: { ToolCallList },
    setup: () => ({ args, filter: ref(args.filter) }),
    template: '<ToolCallList v-bind="args" v-model:filter="filter" />',
  }),
} satisfies Meta<typeof ToolCallList>
export default meta

type Story = StoryObj<typeof meta>

const trajectory = loginToolCalls
const failingCalls = trajectory.filter((c) => !c.ok)
const failures = loginToolFailures

const loaded = {
  trajectory: { toolCalls: trajectory, truncated: false },
  failures,
}

/** Seven calls, one failed: the chips read All 7, Failed 1, OK 6. */
export const Default: Story = { args: loaded }

/** Both reads in flight: three placeholder rows. */
export const Loading: Story = { args: { loading: true, failuresLoading: true } }

/** The trajectory read failed: the message and Retry. */
export const Error: Story = {
  args: { failures, error: 'Internal server error' },
}

/** The run made no tool calls: the aggregate says zero, so the empty state says so too. */
export const Empty: Story = {
  args: { failures: { total: 0, failed: 0, failures: [], failuresTruncated: false } },
}

/** Narrowed to Failed: the failing test run, from the run-level failure read. */
export const FailedOnly: Story = { args: { ...loaded, filter: 'error' } }

/** Narrowed to Failed on a run with no failures: nothing matches, which is the good news. */
export const NoMatches: Story = {
  args: {
    trajectory: { toolCalls: trajectory.filter((c) => c.ok), truncated: false },
    failures: { total: 6, failed: 0, failures: [], failuresTruncated: false },
    filter: 'error',
  },
}

/**
 * The run made 2,412 calls and the trajectory holds the first seven: the notice says the list is
 * a prefix, while the chips count the whole run.
 */
export const Truncated: Story = {
  args: {
    trajectory: { toolCalls: trajectory, truncated: true },
    failures: { total: 2_412, failed: 38, failures: failingCalls, failuresTruncated: true },
  },
}

/** The failing test run opened: its command, and the test output in the error colour. */
export const Expanded: Story = {
  args: loaded,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getAllByRole('button', { name: /bash/ })[0]!)
    await canvas.findByText('Arguments')
  },
}

/**
 * The workspace does not store agent context, so no bodies were captured: the opened row says
 * that nothing can be read from their absence.
 */
export const BodiesNotStored: Story = {
  args: {
    trajectory: {
      toolCalls: trajectory.map((c) => ({
        ...c,
        bodies: 'withheld' as const,
        args: '',
        result: '',
      })),
      truncated: false,
    },
    failures,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getAllByRole('button', { name: /bash/ })[0]!)
    await canvas.findByText(/Arguments and results were not captured/)
  },
}
