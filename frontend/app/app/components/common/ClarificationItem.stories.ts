import type { Meta, StoryObj } from '@storybook/vue3'
import ClarificationItem from './ClarificationItem.vue'

// One question with its answer box, shared by the interview windows. A model suggestion shows
// beside the answer, never in it, until the user picks "Use this answer".
//
// The Recommend button shows only with `canRecommend: true`. The prop comment says it defaults to
// true, but Vue casts an absent boolean prop to false, and the one caller does not pass it.
const meta = {
  title: 'Primitives/Components/ClarificationItem',
  component: ClarificationItem,
  parameters: { width: 'prose' },
  args: {
    prompt: 'Should expired sessions be revoked on the server, or only dropped client-side?',
  },
} satisfies Meta<typeof ClarificationItem>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: {} }

export const WithDetail: Story = {
  args: {
    detail: 'The task says "log the user out" without saying whether other devices are affected.',
  },
}

export const Answered: Story = {
  args: { answer: 'Revoke server-side. Other devices should lose the session too.' },
}

/** Marked not relevant: the answer box gives way to a Reopen action. */
export const Dismissed: Story = { args: { dismissed: true } }

/** A model recommendation, offered but not applied. It must read as a suggestion. */
export const WithRecommendation: Story = {
  args: {
    recommendation: 'Revoke server-side: the task mentions a shared account.',
  },
}

/** With the Recommend button. */
export const CanRecommend: Story = { args: { canRecommend: true } }

/** A recommend request is in flight for this item: the button shows it. */
export const Recommending: Story = { args: { canRecommend: true, recommending: true } }

/** A recommendation is being generated: the answer box gives way to a working line. */
export const Requested: Story = { args: { requested: true } }

/** Frozen: the interview settled, or a background pass is running. */
export const Disabled: Story = {
  args: { answer: 'Revoke server-side.', disabled: true },
}
