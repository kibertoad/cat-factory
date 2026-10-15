import type { Meta, StoryObj } from '@storybook/vue3'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useTutorialStore } from '~/stores/tutorial'
import TutorialCatalogue from './TutorialCatalogue.vue'

// Every guided walkthrough the app ships, each with the button to start it. A tour this board
// cannot run yet lists what it still needs. The tours and what they need come from the app's own
// tour registry, checked against the stores, so each story seeds a board and opens the catalogue
// through the tutorial store.
const meta = {
  title: 'Shell/Components/TutorialCatalogue',
  component: TutorialCatalogue,
} satisfies Meta<typeof TutorialCatalogue>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The shared board: two services and four tasks, no runs. The tours about the board and about
 * adding work can start. The tours about a parked, failed or finished run, and the ones that need
 * GitHub, the advanced tier or a design source, list what they need.
 */
export const Default: Story = {
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot())
      useTutorialStore().openCatalogue()
    }),
  ],
}

/**
 * The board tour finished and the first task tour broken off at step 3: a Completed badge with
 * Repeat, a Paused badge with Resume, the count of finished tours, and Reset progress in the
 * footer.
 */
export const WithProgress: Story = {
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot())
      const tutorial = useTutorialStore()
      tutorial.acceptOffer()
      tutorial.markCompleted('board-basics')
      tutorial.interrupted = { tourId: 'first-task', stepIndex: 2 }
      tutorial.openCatalogue()
    }),
  ],
}

/** A board with nothing on it: only the tours that need no board state can start. */
export const EmptyBoard: Story = {
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot({ blocks: [] }))
      useTutorialStore().openCatalogue()
    }),
  ],
}
