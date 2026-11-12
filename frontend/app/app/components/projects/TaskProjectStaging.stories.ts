import type { Meta, StoryObj } from '@storybook/vue3'
import type { Project, ProjectKindDescriptor } from '@cat-factory/contracts'
import { boardBlocks, boardWith, loginTask } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useProjectsStore } from '~/stores/projects'
import TaskProjectStaging from './TaskProjectStaging.vue'

// The create-task form's linked projects: projects staged before the task exists, linked once it
// is created. Staging sends no request.
const meta = {
  title: 'Board/Components/TaskProjectStaging',
  component: TaskProjectStaging,
  args: { modelValue: [] },
} satisfies Meta<typeof TaskProjectStaging>
export default meta

type Story = StoryObj<typeof meta>

const researchKind: ProjectKindDescriptor = {
  id: 'research',
  label: 'Research',
  definition: 'required',
  taskTypes: [{ taskType: 'research', repoAccess: 'linked-read-only' }],
}

const vendorProject: Project = {
  id: 'prj_vendor',
  accountId: 'acc_story',
  kind: 'research',
  rootBlockId: 'prj_root_vendor',
  serviceIds: [],
  createdAt: 0,
}

const projectRoot = {
  ...loginTask,
  id: 'prj_root_vendor',
  title: 'Content platform research',
  level: 'project' as const,
  type: 'project' as const,
  parentId: null,
}

const withProjects = withSeed(() => {
  seedWorkspace()
  seedBoard(boardWith(projectRoot))
  const projects = useProjectsStore()
  projects.kinds = [researchKind]
  projects.catalog = [vendorProject]
})

/** A research project offered in the picker, nothing staged yet. */
export const Offered: Story = { decorators: [withProjects] }

/** The project staged: it is linked once the task is created. */
export const Staged: Story = {
  decorators: [withProjects],
  args: { modelValue: [vendorProject.id] },
}

/** No project keeps a result on this board, so the field is withheld. */
export const NoProjects: Story = {
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedBoard(boardBlocks)
    }),
  ],
}
