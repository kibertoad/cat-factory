import type { Meta, StoryObj } from '@storybook/vue3'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useTutorialStore } from '~/stores/tutorial'
import TutorialPrompt from './TutorialPrompt.vue'

// The question at first launch: take a guided tour? It lists the first-run tours this board can
// run, from the app's own tour registry, so each story seeds the shared board and opens the
// prompt through the tutorial store.
//
// No story shows the empty state: the board tour needs nothing, so it is always on offer with the
// built-in tours. Only a deployment that removes it can reach that state.
const meta = {
  title: 'Shell/Components/TutorialPrompt',
  component: TutorialPrompt,
} satisfies Meta<typeof TutorialPrompt>
export default meta

type Story = StoryObj<typeof meta>

/** No answer yet: the tours on offer, with No thanks and Maybe later. */
export const Default: Story = {
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot())
      useTutorialStore().openPrompt()
    }),
  ],
}

/**
 * Opened again after the user took the board tour: it has a Completed badge and a button to take
 * it again, and Close replaces No thanks and Maybe later.
 */
export const Decided: Story = {
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot())
      const tutorial = useTutorialStore()
      tutorial.acceptOffer()
      tutorial.markCompleted('board-basics')
      tutorial.openPrompt()
    }),
  ],
}
