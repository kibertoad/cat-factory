import type { Meta, StoryObj } from '@storybook/vue3'
import { screenshotPng } from '~/stories/artifact.stories.mocks'
import TaskImageStaging from './TaskImageStaging.vue'

// The images a task will carry, in the add-task form: held as local files until the task exists,
// each previewed from the file itself. Nothing here talks to the backend.

const meta = {
  title: 'Board/Components/TaskImageStaging',
  component: TaskImageStaging,
  args: {
    modelValue: [new File([screenshotPng], 'crash-on-save.png', { type: 'image/png' })],
  },
  parameters: { width: 'panel' },
} satisfies Meta<typeof TaskImageStaging>
export default meta

type Story = StoryObj<typeof meta>

/** One image staged, previewed from the picked file. */
export const Default: Story = {}

/** Nothing staged: the heading, what images are for, and the picker. */
export const Empty: Story = { args: { modelValue: [] } }
