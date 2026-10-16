import type { Meta, StoryObj } from '@storybook/vue3'
import MarkdownProse from './MarkdownProse.vue'

// Agent prose (a rationale, a summary) rendered as markdown, with raw HTML disabled. Null or
// blank text renders an empty element, so there is no story for it.
const meta = {
  title: 'Primitives/Components/MarkdownProse',
  component: MarkdownProse,
  parameters: { width: 'prose' },
} satisfies Meta<typeof MarkdownProse>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    text: [
      '## What I changed',
      '',
      'Replaced the token refresh with a single-flight lock, so two tabs cannot race.',
      '',
      '- `useSession` now awaits the in-flight refresh',
      '- the retry budget moved to the transport',
      '',
      '```ts',
      'const token = await session.refresh()',
      '```',
      '',
      'See `auth/session.ts` for the rest.',
    ].join('\n'),
  },
}

/** A single paragraph, the common case. */
export const Plain: Story = {
  args: { text: 'No changes were needed: the fix was already on main.' },
}
