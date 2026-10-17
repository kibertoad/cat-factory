import type { Meta, StoryObj } from '@storybook/vue3'
import type { RunFailureEvidence } from '~/utils/observability'
import RunFailureSummary from './RunFailureSummary.vue'

// The first section of the run telemetry panel: the run's failure record, then the last failed
// model call and tool call. With no failing call to pin, a line says why, and the reason depends
// on what each telemetry sink answered. These stories show only that case; none pins a call.
const answered = { status: 'answered', rows: 0 } as const

const base: RunFailureEvidence = {
  failure: {
    kind: 'stalled',
    message: 'The run was still running but its driver was gone.',
    detail: 'advance job orphaned after an orchestrator restart',
    hint: 'Retry spins a fresh run.',
    occurredAt: Date.UTC(2026, 9, 11, 9, 32, 0),
    lastSubtasks: null,
  },
  lastErroredCall: null,
  erroredCallCount: 0,
  lastFailedToolCall: null,
  failedToolCallCount: 0,
  failedToolCallsTruncated: false,
  calls: answered,
  tools: answered,
}

const meta = {
  title: 'Run telemetry/Components/RunFailureSummary',
  component: RunFailureSummary,
  parameters: { width: 'panel' },
} satisfies Meta<typeof RunFailureSummary>
export default meta

type Story = StoryObj<typeof meta>

/** Both sinks answered with no rows: "no telemetry", so the run failed before any agent work. */
export const Default: Story = { args: { evidence: base } }

/** Neither sink has answered yet: no conclusion line at all. */
export const SinksPending: Story = {
  args: { evidence: { ...base, calls: { status: 'pending' }, tools: { status: 'pending' } } },
}

/** The tool sink could not be loaded: a warning line and a Retry button. */
export const SinkUnreachable: Story = {
  args: { evidence: { ...base, tools: { status: 'unreachable' } } },
}
