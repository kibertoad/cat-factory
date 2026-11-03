import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { block } from '~/stories/block.stories.mocks'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { inspectorApi } from '~/stories/inspectorApi'
import { skillCatalog } from '~/stories/skills.stories.mocks'
import { seedBoard, seedVcs, seedViewer, seedWorkspace, withSeed } from '~/stories/withStores'
import { useSkillsStore } from '~/stores/skills'
import type { Block } from '~/types/domain'
import TaskReviewTarget from './TaskReviewTarget.vue'

// The pull request a review task reviews: a link to it, the guided-review entry, the focus the
// creator gave, and the ordered queue of review skills. The queue can change here, because a
// queued skill that leaves the catalog fails every dispatch of the task. An edit is held until
// Save, which sends a request no story answers. The guided-review button needs the service's
// repository, which the section loads itself; the GitHub reads are the inspector's shared
// answers. The section starts open.
const meta = {
  title: 'Inspector/Components/TaskReviewTarget',
  component: TaskReviewTarget,
  args: { block: reviewTask() },
  decorators: [withReview(reviewTask())],
  parameters: { width: 'panel', api: inspectorApi() },
} satisfies Meta<typeof TaskReviewTarget>
export default meta

type Story = StoryObj<typeof meta>

/** A review task under the Auth Service, on PR #57, with two skills queued. */
function reviewTask(fields: Block['taskTypeFields'] = {}): Block {
  return block({
    id: 'task_review_57',
    title: 'Review the session store rewrite',
    parentId: 'svc_auth',
    status: 'planned',
    progress: 0,
    taskType: 'review',
    taskTypeFields: {
      prNumber: 57,
      prUrl: 'https://github.com/acme/auth-service/pull/57',
      reviewFocus: 'Token revocation on logout and the migration of existing sessions.',
      reviewSkillIds: ['skill_security', 'skill_migrations'],
      ...fields,
    },
  })
}

/** The board with `task`, the Auth Service linked to its repo, and the skill catalog. */
function withReview(task: Block, options: { viewer?: boolean } = {}) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard([...boardBlocks, task])
    seedVcs()
    useSkillsStore().hydrate(skillCatalog)
    if (options.viewer) seedViewer()
  })
}

/** The PR link by number, Explore with guided review, the focus and the two skills in order. */
export const Default: Story = {}

const numberOnly = reviewTask({ prUrl: undefined })

/**
 * Created while no VCS was connected: the task keeps only the number, so the reference is text,
 * not a link. The guided review still opens from the service's repository.
 */
export const NumberOnly: Story = {
  args: { block: numberOnly },
  decorators: [withReview(numberOnly)],
}

/**
 * A board viewer: no guided-review entry, which is a write. The queue stays editable, because the
 * inspector disables only its run and delete controls for a viewer, and a Save would be refused.
 */
export const ReadOnly: Story = {
  decorators: [withReview(reviewTask(), { viewer: true })],
}

/** The security skill removed from the queue: Save and Revert show until the edit is settled. */
export const QueueEdited: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const [security] = await canvas.findAllByTestId('review-skill-badge')
    await userEvent.click(security!)
    await canvas.findByTestId('inspector-review-skills-save')
  },
}
