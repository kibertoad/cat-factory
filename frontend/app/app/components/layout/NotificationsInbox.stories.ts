import type { Meta, StoryObj } from '@storybook/vue3'
import type { Notification } from '@cat-factory/contracts'
import { listMergeClassRollupsContract } from '@cat-factory/contracts'
import { expect, screen, userEvent } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { mergeClassRollups } from '~/stories/mergeTrackRecord.stories.mocks'
import {
  ciFailedCard,
  mergeReviewCard,
  platformHealthCard,
  prReviewCard,
} from '~/stories/notifications.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, seedViewer, withSeed } from '~/stories/withStores'
import NotificationsInbox from './NotificationsInbox.vue'

// The toolbar bell and its count, which opens the open cards: each with its icon, the backend's
// title and body, a link to the pull request where there is one, and its actions. A merge card
// asks how much review the pull request needed, with that change class's record, which the inbox
// reads once. A card past the escalation threshold is overdue, and turns the bell red. The cards
// are the shared ones (`notifications.stories.mocks.ts`). The stories with the panel open click
// the bell; the wrapper leaves room under it.
function inbox(cards: Notification[], { viewer = false } = {}) {
  return withSeed(() => {
    seedSnapshot(snapshot({ executions: [execution()], notifications: cards }))
    if (viewer) seedViewer()
  })
}

async function openInbox() {
  await userEvent.click(await screen.findByTestId('notifications-bell'))
  await screen.findAllByTestId('notification-item')
}

const meta = {
  title: 'Board/Components/NotificationsInbox',
  component: NotificationsInbox,
  render: () => ({
    components: { NotificationsInbox },
    template: '<div class="flex justify-end pb-120"><NotificationsInbox /></div>',
  }),
  parameters: {
    api: [
      apiResponse(listMergeClassRollupsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: mergeClassRollups,
      }),
    ],
  },
} satisfies Meta<typeof NotificationsInbox>
export default meta

type Story = StoryObj<typeof meta>

const cards = [mergeReviewCard, prReviewCard, ciFailedCard]

/** Three open cards: the bell and its count. */
export const Default: Story = {
  decorators: [inbox(cards)],
}

/**
 * Open: the merge card with its review effort chips and the source class's record, the review
 * card that opens its window, and CI that gave up.
 */
export const Open: Story = {
  decorators: [inbox(cards)],
  play: openInbox,
}

/** The merge card waited past the escalation threshold: Overdue, and the bell turns red. */
export const Urgent: Story = {
  decorators: [inbox([{ ...mergeReviewCard, severity: 'urgent' }, prReviewCard])],
  play: async () => {
    await openInbox()
    await screen.findByText('Overdue')
  },
}

/**
 * The deployment's run health crossed a threshold: the failing runs behind it (a run that is no
 * longer loaded and has no task is plain text), and how many it left out.
 */
export const PlatformHealth: Story = {
  decorators: [inbox([platformHealthCard])],
  play: async () => {
    await openInbox()
    await screen.findByTestId('notification-failing-runs')
  },
}

/** A board viewer: every action is disabled. */
export const Viewer: Story = {
  decorators: [inbox(cards, { viewer: true })],
  play: async () => {
    await openInbox()
    for (const dismiss of await screen.findAllByTestId('notification-dismiss')) {
      await expect(dismiss).toBeDisabled()
    }
  },
}
