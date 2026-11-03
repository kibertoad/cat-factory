import type { Meta, StoryObj } from '@storybook/vue3'
import { parkedExecution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useTutorialStore } from '~/stores/tutorial'
import TutorialNudge from './TutorialNudge.vue'

// The corner card that offers one walkthrough when the user's own work has just made it
// relevant. The card shows only while the offered tour can start, so the story seeds a board
// where the login run waits for the plan approval, and offers the tour about answering a park.
// The card is `fixed` to the bottom corner of the window. The wrapper has a transform, which makes
// it the card's containing block, so the card sits in the wrapper's corner instead.
const meta = {
  title: 'Shell/Components/TutorialNudge',
  component: TutorialNudge,
  parameters: { layout: 'fullscreen' },
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot({ executions: [parkedExecution()] }))
      useTutorialStore().offerNudge('answer-park')
    }),
  ],
  render: () => ({
    components: { TutorialNudge },
    template: '<div class="h-64 transform-gpu"><TutorialNudge /></div>',
  }),
} satisfies Meta<typeof TutorialNudge>
export default meta

type Story = StoryObj<typeof meta>

/** The tour's name and description, with Show me and a dismiss button. */
export const Default: Story = {}
