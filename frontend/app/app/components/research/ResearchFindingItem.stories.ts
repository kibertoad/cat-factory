import type { Meta, StoryObj } from '@storybook/vue3'
import { researchBoardView } from '~/stories/research.stories.mocks'
import { readerTopics, researchReadingOf } from '~/utils/research'
import ResearchFindingItem from './ResearchFindingItem.vue'

// One research question with its current answer: status, confidence, the answer, its evidence
// and caveats. A blocked answer names the credential it waited for.
const topics = readerTopics(researchReadingOf(researchBoardView)!).topics

const meta = {
  title: 'Board/Components/ResearchFindingItem',
  component: ResearchFindingItem,
  parameters: { width: 'panel' },
  args: { entry: topics[0]!.questions[0]! },
} satisfies Meta<typeof ResearchFindingItem>
export default meta

type Story = StoryObj<typeof meta>

/** An answered question with a documentation link and a recorded request as evidence. */
export const Answered: Story = {}

/** A question blocked on a vendor login the board has not stored. */
export const Blocked: Story = { args: { entry: topics[0]!.questions[1]! } }

/** A question no research task has answered yet. */
export const Unanswered: Story = { args: { entry: topics[1]!.questions[0]! } }
