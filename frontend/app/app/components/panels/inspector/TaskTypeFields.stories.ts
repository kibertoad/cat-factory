import type { CustomTaskType } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'

import { boardBlocks, loginTask } from '~/stories/board.stories.mocks'
import { seedBoard, withSeed } from '~/stories/withStores'
import { useTaskTypesStore } from '~/stores/taskTypes'
import TaskTypeFields from './TaskTypeFields.vue'
import { opensTo } from '~/stories/inspectorSection'

// The answers to a custom task type's own fields, editable after the task exists, through the same
// field renderer the create form uses. Save and Revert appear once an answer changes. A built-in
// task type, or a custom type with its own form panel, renders nothing, so there is no story for
// either. The section starts closed, so each story opens it.
const securityReview: CustomTaskType = {
  taskType: 'acme:security-review',
  presentation: {
    label: 'Security review',
    icon: 'i-lucide-shield',
    color: 'var(--app-hue-rose)',
    description: 'A focused review of one surface against the threat model.',
  },
  fields: [
    {
      key: 'surface',
      label: 'Surface',
      type: 'select',
      required: true,
      options: [
        { value: 'api', label: 'Public API' },
        { value: 'auth', label: 'Sign-in flow' },
      ],
    },
    { key: 'notes', label: 'What to look at', type: 'textarea' },
  ],
}

const meta = {
  title: 'Inspector/Components/TaskTypeFields',
  component: TaskTypeFields,
  parameters: { width: 'panel' },
  decorators: [
    withSeed(() => {
      seedBoard(boardBlocks)
      useTaskTypesStore().registerConsumerTaskTypes([securityReview])
    }),
  ],
} satisfies Meta<typeof TaskTypeFields>
export default meta

type Story = StoryObj<typeof meta>

/**
 * `InspectorSection` opens closed, so each play opens it first and then waits for what the story
 * shows.
 */
/** Both fields answered. */
export const Default: Story = {
  args: {
    block: {
      ...loginTask,
      taskType: 'acme:security-review',
      taskTypeFields: {
        custom: { surface: 'auth', notes: 'Session fixation after the refresh change.' },
      },
    },
  },
  play: opensTo((c) => c.findByDisplayValue('Session fixation after the refresh change.')),
}

/** Nothing answered yet, which is how a task created through the API arrives. */
export const Unanswered: Story = {
  args: { block: { ...loginTask, taskType: 'acme:security-review' } },
  play: opensTo((c) => c.findByTestId('task-type-field-notes')),
}
