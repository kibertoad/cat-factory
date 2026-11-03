import type { Meta, StoryObj } from '@storybook/vue3'
import type { Service, WorkspaceSnapshot } from '@cat-factory/contracts'
import { listMergeClassRollupsContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import { block } from '~/stories/block.stories.mocks'
import { laneSnapshot } from '~/stories/lanes.stories.mocks'
import { mergeClassRollups } from '~/stories/mergeTrackRecord.stories.mocks'
import { ciFailedCard, mergeReviewCard } from '~/stories/notifications.stories.mocks'
import { spendStatus } from '~/stories/providers.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { authServiceRow } from '~/stories/vcs.stories.mocks'
import { seedLaneView, seedSnapshot, seedUiMode, seedViewer, withSeed } from '~/stories/withStores'
import { useWorkspaceStore } from '~/stores/workspace'
import BoardToolbar from './BoardToolbar.vue'

// The pill over the board: zoom out, the zoom level and its band (a click resets it), zoom in and
// fit; then the open decision count, which opens the queue, the lane arrangement, the services to
// add and restore, the inbox, and the month's spend. Each part shows only when it has something to
// say. The spend comes from the workspace store, which the snapshot fan-out does not fill, so the
// stories set it. The org's Billing service is not on this board; its id and its archived
// neighbour are made up.
const billingService: Service = {
  id: 'service_billing',
  accountId: null,
  frameBlockId: 'svc_billing',
  installationId: 9001,
  repoGithubId: null,
  createdAt: Date.UTC(2026, 8, 3),
  mountCount: 1,
}

const legacyService = block({
  id: 'svc_legacy_sso',
  title: 'Legacy SSO bridge',
  level: 'frame',
  parentId: null,
  archived: true,
})

/**
 * The lane board, with its open decision, two inbox cards, Billing to add and the SSO bridge to
 * restore. Auth Service is mounted here, so only Billing is offered.
 */
function busyBoard(): WorkspaceSnapshot {
  return laneSnapshot({
    notifications: [mergeReviewCard, ciFailedCard],
    mounts: [
      {
        workspaceId: STORY_WORKSPACE_ID,
        serviceId: authServiceRow.id,
        position: { x: 0, y: 0 },
        createdAt: Date.UTC(2026, 8, 1),
      },
    ],
    serviceCatalog: [authServiceRow, billingService],
    archivedServices: [legacyService],
  })
}

function toolbar(
  next: WorkspaceSnapshot,
  { spent = 182.4, exceeded = false, viewer = false } = {},
) {
  return withSeed(() => {
    seedSnapshot(next)
    seedUiMode('advanced')
    seedLaneView()
    useWorkspaceStore().spend = spendStatus({ costSpent: spent, exceeded })
    if (viewer) seedViewer()
  })
}

const meta = {
  title: 'Board/Components/BoardToolbar',
  component: BoardToolbar,
  parameters: {
    api: [
      apiResponse(listMergeClassRollupsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: mergeClassRollups,
      }),
    ],
  },
} satisfies Meta<typeof BoardToolbar>
export default meta

type Story = StoryObj<typeof meta>

/** A quiet board at 100%: the zoom controls, Arrange, and the month's spend. */
export const Default: Story = {
  decorators: [toolbar(snapshot())],
}

/**
 * One open decision, Billing to add, one archived service, and two cards in the inbox. The
 * decision count opens the queue. Add service names Billing by its frame block id: a catalog row
 * carries no title, and a service on another board has no block on this one.
 */
export const Busy: Story = {
  decorators: [toolbar(busyBoard())],
}

/** The month's budget is spent: the spend turns red, and its title says the limit is reached. */
export const SpendExceeded: Story = {
  decorators: [toolbar(snapshot(), { spent: 503.8, exceeded: true })],
}

/** A board viewer: no Add service and no archived services, which are board writes. */
export const Viewer: Story = {
  decorators: [toolbar(busyBoard(), { viewer: true })],
}
