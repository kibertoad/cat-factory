import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import type { ProviderConnection } from '~/types/providerConnections'
import KubernetesEnvironmentForm from './KubernetesEnvironmentForm.vue'

// The older single-connection Kubernetes environment form, which carries the manifest source as
// well as the cluster. Connect stays disabled until the required fields are filled in, and a red
// line beside it names the ones missing. Unlike KubernetesEngineForm, this form does not keep a
// stored token: a saved connection needs the token typed again before Save enables, and nothing
// on the form says so. The connection is made up; the test verdict is the backend's own words.
function connection(manifestSource: Record<string, unknown>): ProviderConnection {
  return {
    kind: 'kubernetes',
    providerId: 'kubernetes',
    label: 'Acme staging cluster',
    baseUrl: 'https://k8s.staging.acme.dev:6443',
    connectedAt: Date.UTC(2026, 8, 25),
    secretKeys: ['apiToken'],
    config: {
      kind: 'kubernetes',
      kubernetes: {
        label: 'Acme staging cluster',
        apiServerUrl: 'https://k8s.staging.acme.dev:6443',
        namespaceTemplate: 'auth-pr-{{pullNumber}}',
        manifestSource,
        url: {
          source: 'ingressTemplate',
          hostTemplate: 'auth-pr-{{pullNumber}}.preview.acme.dev',
          scheme: 'https',
        },
      },
    },
  }
}

const colocated = connection({ type: 'colocated', path: 'deploy/preview' })

const meta = {
  title: 'Settings/Components/KubernetesEnvironmentForm',
  component: KubernetesEnvironmentForm,
  parameters: { width: 'prose' },
  args: {
    connection: null,
    supportsTest: false,
    testing: false,
    busy: false,
    testResult: null,
    onTest: fn(),
    onSave: fn(),
  },
} satisfies Meta<typeof KubernetesEnvironmentForm>
export default meta

type Story = StoryObj<typeof meta>

/** A blank form: Connect is disabled, and the line names the missing fields. */
export const Default: Story = {}

/** A saved connection with the manifests in the service's own repo: Save waits for the token. */
export const Editing: Story = { args: { connection: colocated } }

/** Manifests kept in a separate repo: the repo and ref fields show. */
export const SeparateManifestRepo: Story = {
  args: {
    connection: connection({
      type: 'separate',
      repo: 'acme/preview-manifests',
      ref: 'main',
      path: 'auth-service',
    }),
  },
}

/**
 * A failed connection test: the apiserver answered with an error, which shows as it came. No
 * warning code applies to a Kubernetes environment, so no warnings show.
 */
export const TestFailed: Story = {
  args: {
    connection: colocated,
    supportsTest: true,
    testResult: {
      ok: false,
      message:
        'apiserver responded 500: {"kind":"Status","apiVersion":"v1","status":"Failure",' +
        '"message":"etcdserver: request timed out","code":500}',
    },
  },
}
