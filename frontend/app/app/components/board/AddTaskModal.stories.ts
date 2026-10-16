import type { Meta, StoryObj } from '@storybook/vue3'
import type {
  CustomTaskType as CustomTaskTypeEntry,
  WorkspaceSnapshot,
} from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import type { PendingContext } from '~/composables/useContextLinking'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { block } from '~/stories/block.stories.mocks'
import { jiraDescriptor, sourceTask, taskSources } from '~/stories/integrations.stories.mocks'
import { taskFormSnapshot } from '~/stories/taskForm.stories.mocks'
import { taskFormApi } from '~/stories/taskFormApi'
import { seedSnapshot, seedUiMode, withSeed } from '~/stories/withStores'
import { useTasksStore } from '~/stores/tasks'
import { useUiStore } from '~/stores/ui'
import type { UiMode } from '~/utils/uiMode'
import AddTaskModal from './AddTaskModal.vue'

// The form that adds a task to a service. The person picks a kind, names the task and describes
// it; each kind has its own fields, and a review task takes a pull request in place of a title.
// The pipeline starts on the kind's default. The advanced tier adds the overrides: technical,
// the merge policy, the model preset and the best-practice fragments. Documents and issues can be
// attached; they are linked once the task exists. The task is only planned here: Add task sends a
// request no story answers. The board is the shared task form board (`taskForm.stories.mocks.ts`).
// Every story also offers Incident: the Storybook host registers the `acme-security` example
// module (`deploy/frontend/app/modular`), which ships that task type. The type stories click the
// kind, as a person does.
const issue = sourceTask()

/** The form on `containerId`, at `mode`, with `prefill` as another surface would hand it over. */
function opened({
  mode = 'basic',
  board = taskFormSnapshot(),
  containerId = authService.id,
  prefill = null,
  trackers = false,
}: {
  mode?: UiMode
  board?: WorkspaceSnapshot
  containerId?: string
  prefill?: Parameters<ReturnType<typeof useUiStore>['openAddTask']>[1]
  trackers?: boolean
} = {}) {
  return withSeed(() => {
    seedSnapshot(board)
    seedUiMode(mode)
    if (trackers) {
      const tasks = useTasksStore()
      tasks.available = true
      tasks.sources = taskSources
    }
    useUiStore().openAddTask(containerId, prefill)
  })
}

/** Click the kind `type`, then wait for `shown`, a field label only that kind draws. */
function pick(type: string, shown?: string | RegExp) {
  return async () => {
    await userEvent.click(await screen.findByTestId(`task-type-${type}`))
    if (shown) await screen.findByText(shown)
  }
}

const meta = {
  title: 'Board/Components/AddTaskModal',
  component: AddTaskModal,
  parameters: { api: taskFormApi() },
} satisfies Meta<typeof AddTaskModal>
export default meta

type Story = StoryObj<typeof meta>

/** A feature on Auth Service, in the basic tier: the kinds, title, description and the pipeline. */
export const Default: Story = {
  decorators: [opened()],
}

/** The advanced tier: technical, the merge policy, the model preset and the fragments too. */
export const Advanced: Story = {
  decorators: [opened({ mode: 'advanced' })],
}

/** A bug: the severity and the steps to reproduce. */
export const Bug: Story = {
  decorators: [opened()],
  play: pick('bug', 'Steps to reproduce'),
}

/**
 * A bug-fishing expedition, in the advanced tier: the angles to fish (none ticked means all), a
 * focus, and the pass budget.
 */
export const BugFishing: Story = {
  decorators: [opened({ mode: 'advanced' })],
  play: pick('bug-fishing', 'Maximum passes'),
}

/** A spike: the timebox, the research question, the success criteria, the options and the path. */
export const Spike: Story = {
  decorators: [opened()],
  play: pick('spike', 'Research question'),
}

/** A document, with PRD picked: the audience, the path, the outline and the PRD's own fields. */
export const Document: Story = {
  decorators: [opened()],
  play: async () => {
    await pick('document')()
    await userEvent.click(await screen.findByRole('button', { name: 'prd' }))
    await screen.findByText('Target users')
  },
}

/** A review: the pull request in place of a title, the focus, and the review playbooks. */
export const Review: Story = {
  decorators: [opened()],
  play: pick('review', 'Review focus'),
}

/** Recurring: the form hands over to the schedule, so only a line and Continue are left. */
export const Recurring: Story = {
  decorators: [opened()],
  play: pick('recurring', /A recurring task runs a pipeline on a cadence/),
}

const handbook = block({
  id: 'svc_handbook',
  title: 'Engineering handbook',
  type: 'document',
  level: 'frame',
  parentId: null,
})

/** On a document repository, which takes only documents and spikes: Document is picked. */
export const DocumentRepository: Story = {
  decorators: [
    opened({
      board: taskFormSnapshot({ blocks: [...boardBlocks, handbook] }),
      containerId: handbook.id,
    }),
  ],
}

const linkedIssue: PendingContext = {
  kind: 'task',
  source: 'jira',
  externalId: issue.externalId,
  title: `${issue.externalId} · ${issue.title}`,
  subtitle: issue.status,
  icon: jiraDescriptor.icon,
  description: issue.description,
  needsImport: false,
}

/**
 * Opened from a Jira issue: the issue's title, its description shown read-only above the notes,
 * and the issue attached.
 */
export const FromIssue: Story = {
  decorators: [opened({ prefill: { title: issue.title, context: [linkedIssue] }, trackers: true })],
  parameters: { api: taskFormApi({ issues: [issue] }) },
}

/** An operation a deployment registers (the public API's task type test uses the same one). */
const introduceApi: CustomTaskTypeEntry = {
  taskType: 'org:introduce-api',
  presentation: {
    label: 'Introduce API',
    icon: 'i-lucide-plug',
    color: '#0ea5e9',
    description: 'Expose functionality over HTTP.',
    category: 'API delivery',
  },
  fields: [
    { key: 'entity', label: 'Entity', type: 'text', required: true },
    {
      key: 'auth',
      label: 'Auth',
      type: 'select',
      required: true,
      default: 'service',
      options: [
        { value: 'service', label: 'Service token' },
        { value: 'user', label: 'User token' },
      ],
    },
  ],
}

/**
 * The deployment's own operation picked: its category caption above it, its description under
 * the kinds, and its declared fields.
 */
export const CustomTaskType: Story = {
  decorators: [opened({ board: taskFormSnapshot({ customTaskTypes: [introduceApi] }) })],
  play: async () => {
    await pick(introduceApi.taskType)()
    await screen.findByTestId('custom-task-fields')
  },
}
