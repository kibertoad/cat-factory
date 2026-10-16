import type { Meta, StoryObj } from '@storybook/vue3'
import type { RunEnvironment } from '~/types/execution'
import EnvironmentStatusPanel from './EnvironmentStatusPanel.vue'

// The test environment a run stood up: its status, address, expiry, and the provision type and
// engine it used. A failed environment shows the provider's error as it came; one still coming
// up shows what the provider says it is waiting on. A status in transition spins only while the
// run is active. The notes and errors are the Kubernetes provider's own words; the rest is made
// up.
//
// Both callers render the panel only when the step has an environment, so its empty state and
// `degradedReason` cannot show in the app, and there is no story for them.
function environment(overrides: Partial<RunEnvironment> = {}): RunEnvironment {
  return {
    id: 'env_auth_pr_212',
    url: 'https://auth-pr-212.preview.acme.dev',
    status: 'ready',
    expiresAt: Date.UTC(2026, 9, 12, 18, 0),
    provisionType: 'kubernetes',
    engine: 'remote-kubernetes',
    ...overrides,
  }
}

const meta = {
  title: 'Run telemetry/Components/EnvironmentStatusPanel',
  component: EnvironmentStatusPanel,
  parameters: { width: 'panel' },
  args: { environment: environment(), runActive: true },
} satisfies Meta<typeof EnvironmentStatusPanel>
export default meta

type Story = StoryObj<typeof meta>

/** Ready: the address, the expiry, the provision type and the engine. */
export const Default: Story = {}

/** Coming up while the run is active: the icon spins, with what the rollout is waiting on. */
export const Provisioning: Story = {
  args: {
    environment: environment({
      url: null,
      status: 'provisioning',
      statusNote: "1 of 3 Deployments is still rolling out: 'auth-api'",
    }),
  },
}

/** The rollout failed: the provider's error, as it came. */
export const Error: Story = {
  args: {
    environment: environment({
      url: null,
      status: 'failed',
      lastError:
        "the Deployment 'auth-api' exceeded its rollout progress deadline: its pods never became " +
        'available, so the cluster stopped waiting for them. That workload is where the cause is ' +
        '(an image that cannot be pulled, a container crash-looping, a pod nothing can schedule), ' +
        'not the namespace as a whole.',
    }),
  },
}

/** Torn down after the run: muted, and no spinner. */
export const TornDown: Story = {
  args: { environment: environment({ status: 'torn_down' }), runActive: false },
}
