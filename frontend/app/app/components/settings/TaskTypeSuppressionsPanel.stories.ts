import { listTaskTypeSuppressionsContract } from '@cat-factory/contracts'
import type { TaskTypeSuppression } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import TaskTypeSuppressionsPanel from './TaskTypeSuppressionsPanel.vue'

// Which of the deployment's reusable operations this board offers in its create picker. The
// operations are registered by the deployment, so their labels and descriptions show as written,
// not translated. The panel loads the list on mount, so each story answers that request. The
// operations are made up.
function operation(
  taskType: string,
  presentation: TaskTypeSuppression['taskType']['presentation'],
  suppressed = false,
): TaskTypeSuppression {
  return { taskType: { taskType, presentation }, suppressed }
}

const operations: TaskTypeSuppression[] = [
  operation('acme:dependency-bump', {
    label: 'Dependency bump',
    icon: 'i-lucide-package',
    color: '#0ea5e9',
    description: 'Raise one dependency to a named version and fix what the upgrade breaks.',
    category: 'Maintenance',
  }),
  operation('acme:feature-flag-cleanup', {
    label: 'Feature flag cleanup',
    icon: 'i-lucide-flag-off',
    color: '#f59e0b',
    description: 'Remove a rolled-out flag and the code path it switched off.',
    category: 'Maintenance',
  }),
  operation(
    'acme:translation-sync',
    {
      label: 'Translation sync',
      icon: 'i-lucide-languages',
      color: '#8b5cf6',
      description: 'Pull the latest strings from the translation platform into the repo.',
      category: 'Localization',
    },
    true,
  ),
]

const listIs = (taskTypes: TaskTypeSuppression[]) =>
  apiResponse(listTaskTypeSuppressionsContract, {
    pathPrefix: storyWorkspacePrefix,
    body: { taskTypes },
  })

const meta = {
  title: 'Settings/Components/TaskTypeSuppressionsPanel',
  component: TaskTypeSuppressionsPanel,
  parameters: { width: 'prose', api: [listIs(operations)] },
  decorators: [withSeed(seedWorkspace)],
} satisfies Meta<typeof TaskTypeSuppressionsPanel>
export default meta

type Story = StoryObj<typeof meta>

/** Three operations, each with its icon, category and description; Translation sync is off. */
export const Default: Story = {}

/** The deployment registers no operations: the empty state. */
export const Empty: Story = { parameters: { api: [listIs([])] } }

/** The list request has not answered: three placeholder rows. */
export const Loading: Story = {
  parameters: {
    api: [apiPending(listTaskTypeSuppressionsContract, { pathPrefix: storyWorkspacePrefix })],
  },
}
