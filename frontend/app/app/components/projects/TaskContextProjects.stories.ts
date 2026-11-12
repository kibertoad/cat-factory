import type { Meta, StoryObj } from '@storybook/vue3'
import type { Project, ProjectKindDescriptor, TaskLinkedProject } from '@cat-factory/contracts'
import { listTaskProjectsContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { boardBlocks, boardWith, loginTask } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useProjectsStore } from '~/stores/projects'
import TaskContextProjects from './TaskContextProjects.vue'

// The task inspector's linked projects: the projects whose current result (a research project's
// findings) every dispatch of the task reads, with a picker over the account's projects that keep
// a result. Linking and unlinking send requests no story answers.
const meta = {
  title: 'Board/Components/TaskContextProjects',
  component: TaskContextProjects,
  args: { block: loginTask },
} satisfies Meta<typeof TaskContextProjects>
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

function withProjects() {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardWith(projectRoot))
    const projects = useProjectsStore()
    projects.kinds = [researchKind]
    projects.catalog = [vendorProject]
  })
}

function linksResponse(projects: TaskLinkedProject[]) {
  return {
    api: [
      apiResponse(listTaskProjectsContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { blockId: loginTask.id },
        body: { projects },
      }),
    ],
  }
}

/** One research project linked, read at every dispatch of the task. */
export const Linked: Story = {
  decorators: [withProjects()],
  parameters: linksResponse([
    {
      projectId: vendorProject.id,
      kind: 'research',
      title: 'Content platform research',
      linkedAt: 0,
    },
  ]),
}

/** Nothing linked yet, with a research project offered in the picker. */
export const NothingLinked: Story = {
  decorators: [withProjects()],
  parameters: linksResponse([]),
}

/** A board with no project to offer: the picker is withheld and only the empty state shows. */
export const NoProjects: Story = {
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedBoard(boardBlocks)
    }),
  ],
  parameters: linksResponse([]),
}
