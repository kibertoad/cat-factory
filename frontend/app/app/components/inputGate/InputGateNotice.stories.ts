import type { Meta, StoryObj } from '@storybook/vue3'
import { blockedInputGate as blockedGate } from '~/stories/pipelineStep.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useInputGateStore } from '~/stores/inputGate'
import InputGateNotice from './InputGateNotice.vue'

// What the check before dispatch found missing in a task's own input, and the two ways out when
// it blocks the run: check again after editing the task, or proceed anyway. The copy comes from
// each finding's code, not from backend prose. Blocking findings sort first. A run's tone is
// decided by `inputGateNoticeFor`: blocked, waived (someone proceeded) or advisory (a passed
// verdict that still carries findings). The findings are those the backend raises for a task of
// a custom incident type with two required fields (`descriptionFinding` and
// `customFieldFindings` in kernel's `input-gate.ts`); the gate is the shared one
// (`blockedInputGate` in `pipelineStep.stories.mocks.ts`).
const meta = {
  title: 'Pipeline/Components/InputGateNotice',
  component: InputGateNotice,
  parameters: { width: 'panel' },
  args: { gate: blockedGate, tone: 'blocked', executionId: 'exec_login' },
} satisfies Meta<typeof InputGateNotice>
export default meta

type Story = StoryObj<typeof meta>

/** Blocked: two blocking findings, each naming its missing field, then Check again and Proceed. */
export const Default: Story = {}

/** Someone proceeded anyway: the same findings, kept as a record, with no actions. */
export const Waived: Story = {
  args: {
    gate: {
      ...blockedGate,
      status: 'overridden',
      overriddenBy: 'usr_maya',
      overriddenAt: Date.UTC(2026, 9, 11, 9, 34),
    },
    tone: 'waived',
  },
}

/** Advisory mode: the run went ahead, and the findings are kept as advice. */
export const Advisory: Story = {
  args: {
    gate: {
      ...blockedGate,
      status: 'passed',
      mode: 'advisory',
      issues: blockedGate.issues.map((i) => ({ ...i, severity: 'advisory' as const })),
    },
    tone: 'advisory',
  },
}

/** The compact form in the step detail rail, without the explanation. */
export const Compact: Story = { args: { compact: true } }

/** A choice in flight: Check again spins and Proceed is disabled. */
export const Resolving: Story = {
  decorators: [
    withSeed(() => {
      useInputGateStore().resolving = true
    }),
  ],
}

/**
 * The last choice failed. The line is the error's own message, untranslated; this one is made
 * up.
 */
export const Error: Story = {
  decorators: [
    withSeed(() => {
      useInputGateStore().error = 'The run is no longer waiting on the input check.'
    }),
  ],
}
