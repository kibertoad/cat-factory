import type { Meta, StoryObj } from '@storybook/vue3'
import { partialProbeReport as partial } from '~/stories/envProbe.stories.mocks'
import EnvProbeReport from './EnvProbeReport.vue'

// What an agent dry run against a service's environment found: a verdict, the platform's tallies,
// what the agent was not told (above the evidence, because it is the thing to fix), blockers, each
// operation it tried, then its own summary. A partial verdict is amber, not red: the run worked
// and the finding is partial. A capped operation list says how many it left out.
const meta = {
  title: 'Inspector/Components/EnvProbeReport',
  component: EnvProbeReport,
  parameters: { width: 'panel' },
} satisfies Meta<typeof EnvProbeReport>
export default meta

type Story = StoryObj<typeof meta>

/** Partly operable: public calls work, signed-in ones are blocked. */
export const Default: Story = { args: { report: partial } }

/** Everything worked, including behind sign-in. */
export const Operable: Story = {
  args: {
    report: {
      surface: 'api',
      verdict: 'operable',
      summary: 'Signed in as the seeded admin and exercised the session endpoints.',
      operations: [
        { name: 'GET /health', authenticated: false, outcome: 'succeeded' },
        { name: 'List sessions', target: '/sessions', authenticated: true, outcome: 'succeeded' },
      ],
      missingContext: [],
      blockers: [],
      attempted: 2,
      succeeded: 2,
      authenticatedSucceeded: 1,
    },
  },
}

/** Nothing could be reached. */
export const Inoperable: Story = {
  args: {
    report: {
      surface: 'ui',
      verdict: 'inoperable',
      summary: 'The preview URL never answered.',
      operations: [
        {
          name: 'Open the sign-in page',
          target: '/login',
          authenticated: false,
          outcome: 'failed',
          failure: 'unreachable',
          detail: 'Connection refused.',
        },
      ],
      missingContext: [],
      blockers: [{ kind: 'unreachable', detail: 'The environment URL refused connections.' }],
      attempted: 1,
      succeeded: 0,
      authenticatedSucceeded: 0,
    },
  },
}

/** The agent reported more operations than are kept, and two replies could not be read. */
export const Capped: Story = {
  args: { report: { ...partial, operationsOmitted: 12, operationsUnreadable: 2 } },
}
