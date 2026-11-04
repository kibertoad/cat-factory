import type { Meta, StoryObj } from '@storybook/vue3'
import StepCheckpointControl from './StepCheckpointControl.vue'

// Where one row of the pipeline builder pauses for a person. A plain step gets a toggle. The
// Architect with its Architect Reviewer gets a menu of four, because the two are separate steps:
// a checkpoint after the Architect fires on every draft, including each rework round the reviewer
// asks for, and one after the reviewer fires once, on the design it passed. A checkpoint the
// built-in ships is locked on.
const meta = {
  title: 'Pipeline/Components/StepCheckpointControl',
  component: StepCheckpointControl,
  args: {
    producerGated: false,
    companionGated: null,
    producerLabel: 'Architect',
    companionLabel: 'Architect Reviewer',
  },
} satisfies Meta<typeof StepCheckpointControl>
export default meta

type Story = StoryObj<typeof meta>

/** A Coder with no checkpoint. */
export const Default: Story = { args: { producerLabel: 'Coder' } }

/** A Coder that pauses for approval. */
export const Gated: Story = { args: { producerLabel: 'Coder', producerGated: true } }

/** The Architect and its reviewer, with no checkpoint yet: the menu offers all four. */
export const WithCompanion: Story = { args: { companionGated: false } }

/** One checkpoint, once the reviewer has passed the design. */
export const AfterCompanion: Story = { args: { companionGated: true } }

/** The Clarity Review checkpoint of the built-in bug fix: on, and not offered for removal. */
export const Locked: Story = {
  args: { producerLabel: 'Clarity Review', producerGated: true, lockedProducer: true },
}

/** An estimate-gated Architect: neither it nor its reviewer is offered a new checkpoint. */
export const Unreachable: Story = {
  args: { companionGated: false, unreachableProducer: true, unreachableCompanion: true },
}
