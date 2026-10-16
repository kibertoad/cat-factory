import type { Meta, StoryObj } from '@storybook/vue3'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useGitHubStore } from '~/stores/github'
import { useTutorialStore } from '~/stores/tutorial'
import { useTutorialTours } from '~/composables/useTutorialTours'
import TutorialOverlay from './TutorialOverlay.vue'

// The coach mark of a running tour: a card with the step's copy, its place in the tour, and Skip,
// Back and Next, and a ring round the control the step names. The app mounts it only while a tour
// runs, so each story starts a tour at a step. A step that names a control looks for it on the
// page, and a component story renders none of the app's shell, so the Highlighted story draws a
// stand-in with the same test id. A step whose control does not come is skipped when its wait
// runs out, so the Searching story moves on by itself. The step index comes from the tour as
// this board resolves it, the same list the overlay walks, because a step's `when` can drop it.
function atStep(tourId: string, stepId: string) {
  return withSeed(() => {
    seedSnapshot(snapshot())
    useGitHubStore().available = true
    const tour = useTutorialTours().tours.value.find((entry) => entry.id === tourId)
    if (!tour) throw new Error(`Tour ${tourId} is not available on this board`)
    const index = tour.steps.findIndex((entry) => entry.id === stepId)
    if (index < 0) throw new Error(`No step ${stepId} in tour ${tourId} on this board`)
    const tutorial = useTutorialStore()
    tutorial.startTour(tourId)
    tutorial.setStepIndex(index)
  })
}

const meta = {
  title: 'Shell/Components/TutorialOverlay',
  component: TutorialOverlay,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof TutorialOverlay>
export default meta

type Story = StoryObj<typeof meta>

/** The board tour's first step names no control: the card alone, in the middle of the frame. */
export const Default: Story = { decorators: [atStep('board-basics', 'welcome')] }

/** The step that names the command bar launcher: the ring round it, and the card beside it. */
export const Highlighted: Story = {
  decorators: [atStep('board-basics', 'commandBar')],
  render: () => ({
    components: { TutorialOverlay },
    template: `
      <div class="p-4">
        <button
          type="button"
          data-testid="command-bar-launcher"
          class="w-60 rounded-lg border border-muted bg-elevated/60 px-2.5 py-2 text-start text-sm text-muted"
        >
          Search or run a command…
        </button>
        <TutorialOverlay />
      </div>`,
  }),
}

/**
 * The step inside the add-service modal, which is not open: the waiting note under the copy. Its
 * wait is eight seconds; then the tour skips it, and the next one too, and ends on the last step.
 * The wait comes from the tour step, and a story cannot set it, so take a capture in the first
 * eight seconds.
 */
export const Searching: Story = { decorators: [atStep('add-service', 'search')] }

/** The board tour's last step: Done, and the tour this board can take next. */
export const LastStep: Story = { decorators: [atStep('board-basics', 'finish')] }
