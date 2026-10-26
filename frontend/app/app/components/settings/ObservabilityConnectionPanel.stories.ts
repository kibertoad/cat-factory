import type { Meta, StoryObj } from '@storybook/vue3'
import { screen } from 'storybook/test'
import type { IncidentEnrichmentView, ObservabilityConnectionView } from '@cat-factory/contracts'
import {
  getIncidentEnrichmentContract,
  getObservabilityConnectionContract,
  listReleaseHealthConfigsContract,
} from '@cat-factory/contracts'
import { apiFailure, apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import ObservabilityConnectionPanel from './ObservabilityConnectionPanel.vue'

// The board's observability provider (Datadog), which the release-health gate reads after a
// release, and the incident tools (PagerDuty, incident.io) the platform annotates when a release
// regresses. Credentials are write-only, so each section says only whether it is set. The window
// loads the connection, the release-health configs and the incident tools when it opens, so each
// story answers those reads.
const pathPrefix = storyWorkspacePrefix

function answers(options: {
  connection?: ObservabilityConnectionView
  connectionFails?: boolean
  incident?: IncidentEnrichmentView | 'unavailable' | 'fails'
}) {
  return [
    options.connectionFails
      ? apiFailure(getObservabilityConnectionContract, { pathPrefix })
      : apiResponse(getObservabilityConnectionContract, {
          pathPrefix,
          body: options.connection ?? { connected: false, provider: null, summary: null },
        }),
    apiResponse(listReleaseHealthConfigsContract, { pathPrefix, body: [] }),
    options.incident === 'fails'
      ? apiFailure(getIncidentEnrichmentContract, { pathPrefix })
      : options.incident === 'unavailable'
        ? apiRefusal(getIncidentEnrichmentContract, {
            pathPrefix,
            status: 503,
            error: {
              code: 'unavailable',
              message: 'The incident-enrichment integration is not configured',
            },
          })
        : apiResponse(getIncidentEnrichmentContract, {
            pathPrefix,
            body: options.incident ?? { connected: false, summary: null },
          }),
  ]
}

const datadogEu: ObservabilityConnectionView = {
  connected: true,
  provider: 'datadog',
  summary: { site: 'datadoghq.eu' },
}

const meta = {
  title: 'Settings/Components/ObservabilityConnectionPanel',
  component: ObservabilityConnectionPanel,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useUiStore().openObservabilityConnection()
    }),
  ],
  parameters: {
    api: answers({
      connection: datadogEu,
      incident: { connected: true, summary: { pagerDuty: true, incidentIo: false } },
    }),
  },
} satisfies Meta<typeof ObservabilityConnectionPanel>
export default meta

type Story = StoryObj<typeof meta>

/** Datadog connected on the EU site, and PagerDuty set for incidents. */
export const Default: Story = {}

/** Nothing connected: both forms, both Not set. */
export const Empty: Story = { parameters: { api: answers({}) } }

/** The deployment has no incident tools wired (the read answers 503): that section is gone. */
export const IncidentUnavailable: Story = {
  parameters: { api: answers({ connection: datadogEu, incident: 'unavailable' }) },
}

/** The incident read failed: that section says so with a retry, rather than disappearing. */
export const IncidentFailed: Story = {
  parameters: { api: answers({ connection: datadogEu, incident: 'fails' }) },
  play: async () => {
    await screen.findByText('Could not load the incident tools')
  },
}

/**
 * The connection read failed: a toast, and the connection section says so with a retry instead
 * of Not connected and the connect form.
 */
export const Failed: Story = {
  parameters: { api: answers({ connectionFails: true }) },
  play: async () => {
    await screen.findByTestId('load-failed-state')
  },
}
