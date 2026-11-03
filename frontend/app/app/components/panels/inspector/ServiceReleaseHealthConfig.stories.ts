import type { Meta, StoryObj } from '@storybook/vue3'
import type { ObservabilityConnectionView, ReleaseHealthConfig } from '~/types/releaseHealth'
import {
  getObservabilityConnectionContract,
  listReleaseHealthConfigsContract,
} from '@cat-factory/contracts'

import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedUiMode, seedWorkspace, withSeed } from '~/stories/withStores'
import type { UiMode } from '~/utils/uiMode'
import ServiceReleaseHealthConfig from './ServiceReleaseHealthConfig.vue'
import { opensTo } from '~/stories/inspectorSection'

// The monitors and SLOs that the post-release-health gate watches after a service ships. The
// workspace has one observability connection; until it is connected, the section offers only a
// way to connect. The section loads the connection and every service's mapping itself. It is an
// advanced-tier section: the basic tier hides it, unless the service already has a mapping. It
// starts closed, so each story opens it. Save and Clear send requests no story answers.

const datadog: ObservabilityConnectionView = {
  connected: true,
  provider: 'datadog',
  summary: { site: 'datadoghq.eu' },
}

const notConnected: ObservabilityConnectionView = {
  connected: false,
  provider: null,
  summary: null,
}

/** Two Datadog monitors and one SLO on the Auth Service, in production. */
const authMapping: ReleaseHealthConfig = {
  blockId: authService.id,
  monitorIds: ['48213907', '48213911'],
  sloIds: ['b1f0c3a2e9d84c6f8a7e5d4c3b2a1f09'],
  envTag: 'prod',
}

const meta = {
  title: 'Inspector/Components/ServiceReleaseHealthConfig',
  component: ServiceReleaseHealthConfig,
  args: { block: authService },
  decorators: [withService('advanced')],
  parameters: { width: 'panel', api: answers(datadog, [authMapping]) },
} satisfies Meta<typeof ServiceReleaseHealthConfig>
export default meta

type Story = StoryObj<typeof meta>

/**
 * `InspectorSection` opens closed, so each play opens it first and then waits for what the story
 * shows.
 */
function withService(mode: UiMode) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    seedUiMode(mode)
  })
}

function answers(connection: ObservabilityConnectionView, configs: ReleaseHealthConfig[]) {
  return [
    apiResponse(getObservabilityConnectionContract, {
      pathPrefix: storyWorkspacePrefix,
      body: connection,
    }),
    apiResponse(listReleaseHealthConfigsContract, {
      pathPrefix: storyWorkspacePrefix,
      body: configs,
    }),
  ]
}

/**
 * Datadog is connected and the service is mapped: the ids in the form, and Clear beside the
 * title. The SLO id is longer than its field.
 */
export const Default: Story = { play: opensTo((c) => c.findByDisplayValue('prod')) }

/** Connected, nothing mapped yet: the empty form, and no Clear. */
export const Empty: Story = {
  parameters: { api: answers(datadog, []) },
  play: opensTo((c) =>
    c.findByText(
      'The monitors and SLOs the gate watches after this service ships. Comma-separate ids.',
    ),
  ),
}

/** No observability connection: one line and a Connect button. */
export const NotConnected: Story = {
  parameters: { api: answers(notConnected, []) },
  play: opensTo((c) =>
    c.findByText('Connect an observability integration to watch this service after releases.'),
  ),
}

/**
 * The basic tier, and a teammate on the advanced tier mapped this service: the section stays, so
 * the mapping can still be seen and cleared.
 */
export const BasicModeWithMapping: Story = {
  decorators: [withService('basic')],
  play: opensTo((c) => c.findByDisplayValue('prod')),
}
