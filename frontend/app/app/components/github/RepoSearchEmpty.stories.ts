import type { Meta, StoryObj } from '@storybook/vue3'
import RepoSearchEmpty from './RepoSearchEmpty.vue'

// The empty body of the GitHub repo pickers: "type more" below the minimum query length, "no
// matches" once a search has settled. While `loading` it renders nothing, so there is no story
// for that.
const meta = {
  title: 'Setup/Components/RepoSearchEmpty',
  component: RepoSearchEmpty,
  parameters: { width: 'panel' },
} satisfies Meta<typeof RepoSearchEmpty>
export default meta

type Story = StoryObj<typeof meta>

/** The search ran and matched nothing. */
export const Default: Story = { args: { belowMinChars: false, loading: false, query: 'pay' } }

/** Too few characters to search yet. */
export const BelowMinimum: Story = { args: { belowMinChars: true, loading: false, query: 'p' } }
