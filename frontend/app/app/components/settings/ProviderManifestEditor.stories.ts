import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import { runnerPoolConnection, runnerPoolManifest } from '~/stories/providers.stories.mocks'
import ProviderManifestEditor from './ProviderManifestEditor.vue'

// The JSON manifest editor for a provider with no native adapter: a runner pool or an
// environment provider. It checks the manifest against the same contract the backend uses, asks
// for every secret the manifest names, and saves only when each one is filled in, because a save
// replaces the stored secrets. With no saved manifest it starts from a starter for its kind.
//
// The saved manifest is the Acme runner pool's (`runnerPoolManifest`). The test verdicts and
// warnings are the backend's own words.
const meta = {
  title: 'Settings/Components/ProviderManifestEditor',
  component: ProviderManifestEditor,
  parameters: { width: 'prose' },
  args: {
    kind: 'runner-pool',
    connected: false,
    supportsTest: true,
    testing: false,
    busy: false,
    testResult: null,
    onTest: fn(),
    onSave: fn(),
  },
} satisfies Meta<typeof ProviderManifestEditor>
export default meta

type Story = StoryObj<typeof meta>

/** A first connect: the runner pool starter, and its API_TOKEN secret to fill in. */
export const Default: Story = {}

/** The environment provider starter. */
export const EnvironmentStarter: Story = { args: { kind: 'environment' } }

/**
 * A saved connection: the saved manifest, the stored secret names, and the hint that a save needs
 * every secret again.
 */
export const Connected: Story = {
  args: {
    savedManifest: runnerPoolManifest,
    connected: true,
    storedSecretKeys: runnerPoolConnection.secretKeys,
  },
}

/** Valid JSON that the contract refuses (no poll request): the first issue, with its path. */
export const SchemaError: Story = {
  args: { savedManifest: { ...runnerPoolManifest, poll: undefined }, connected: true },
}

/** A test the pool refused, with the warning that the manifest maps no status path. */
export const TestFailed: Story = {
  args: {
    savedManifest: {
      ...runnerPoolManifest,
      response: { ...runnerPoolManifest.response, statusPath: undefined },
    },
    connected: true,
    storedSecretKeys: runnerPoolConnection.secretKeys,
    testResult: {
      ok: false,
      message: 'Credentials rejected (HTTP 401)',
      warnings: [
        {
          code: 'runner_manifest_no_status_path',
          message:
            "Manifest 'acme-runners' maps no status path, so every poll reads as still running " +
            "and a job can only end by exhausting the run's poll budget.",
        },
      ],
    },
  },
}
