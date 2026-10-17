import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import { kubernetesHandler, kubernetesTestPassed } from '~/stories/infra.stories.mocks'
import KubernetesEngineForm from './KubernetesEngineForm.vue'

// The cluster connection form of a Kubernetes test environment handler: the apiserver, TLS, the
// namespace and how the environment URL is found. It serves the remote-kubernetes and local-k3s
// engines. Connect stays disabled until the required fields are filled in, and a red line beside
// it names the ones missing. The token is write-only, so a saved handler shows it as stored.
// The test verdicts are the backend's own words.
const meta = {
  title: 'Settings/Components/KubernetesEngineForm',
  component: KubernetesEngineForm,
  parameters: { width: 'prose' },
  args: {
    engine: 'remote-kubernetes',
    handler: null,
    supportsTest: false,
    testing: false,
    busy: false,
    testResult: null,
    onTest: fn(),
    onSave: fn(),
  },
} satisfies Meta<typeof KubernetesEngineForm>
export default meta

type Story = StoryObj<typeof meta>

/** A blank remote cluster form: Connect is disabled, and the line names the missing fields. */
export const Default: Story = {}

/**
 * The local-k3s engine: the loopback apiserver and the TLS skip filled in, and the auto-setup
 * command with its copy button.
 */
export const LocalK3s: Story = { args: { engine: 'local-k3s' } }

/** The Acme staging cluster, saved: every field filled in from it, and the token stored. */
export const Editing: Story = { args: { handler: kubernetesHandler } }

/**
 * A local-k3s form filled in from the `cat-factory k3s` command's link, which reported an
 * ingress on port 18080. Only the token is left to paste. The values are made up.
 */
export const Prefilled: Story = {
  args: {
    engine: 'local-k3s',
    prefill: {
      label: 'k3d cat-factory',
      apiServerUrl: 'https://127.0.0.1:41583',
      namespaceTemplate: 'cf-{{pullNumber}}',
      hostTemplate: 'cf-{{pullNumber}}.localtest.me',
      ingressPort: '18080',
      urlScheme: 'http',
      insecureSkipTlsVerify: true,
    },
  },
}

/** A passing connection test on the saved cluster. */
export const TestPassed: Story = {
  args: {
    handler: kubernetesHandler,
    supportsTest: true,
    testResult: kubernetesTestPassed,
  },
}

/** A failed connection test: the token works, but the service account may not list namespaces. */
export const TestFailed: Story = {
  args: {
    handler: kubernetesHandler,
    supportsTest: true,
    testResult: {
      ok: false,
      message:
        'The apiserver authenticated the token but denied the request (403 Forbidden): the ' +
        'ServiceAccount is not allowed to list namespaces. Bind it to a Role/ClusterRole ' +
        'granting that access, then test again. Details: namespaces is forbidden: User ' +
        '"system:serviceaccount:cat-factory:previews" cannot list resource "namespaces" in API ' +
        'group "" at the cluster scope',
    },
  },
}
