import type { Meta, StoryObj } from '@storybook/vue3'
import { computed } from 'vue'
import type { ProvisioningRecommendation } from '@cat-factory/contracts'
import {
  detectServiceProvisioningContract,
  listEnvironmentHandlersContract,
} from '@cat-factory/contracts'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { boardApi } from '~/stories/boardApi'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import {
  kubernetesHandler,
  registeredManifestType,
  workspaceManifestType,
} from '~/stories/infra.stories.mocks'
import { seedBoard, seedVcs, seedWorkspace, withSeed } from '~/stories/withStores'
import { useBoardStore } from '~/stores/board'
import { useGitHubStore } from '~/stores/github'
import type { Block, ServiceProvisioning } from '~/types/domain'
import ServiceTestConfig from './ServiceTestConfig.vue'

// How a service is stood up for its tests: the provision type it produces, and what that type
// needs from its own repository (a compose file, Kubernetes manifests in this repo or another, or
// a manifest of a type the deployment or workspace registered). The workspace decides how each
// type is handled; this section only says what and where. Detect from repo reads the repository
// and proposes a config, which Apply saves. The section starts closed in the inspector, so each
// story opens it. The Auth Service's repository is the shared one; its paths and the detection
// notes are made up, and the detect failure is the backend's own wording.
const pathPrefix = storyWorkspacePrefix

function seeded(provisioning?: ServiceProvisioning) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(
      boardBlocks.map((b) =>
        b.id === authService.id ? { ...b, ...(provisioning ? { provisioning } : {}) } : b,
      ),
    )
    seedVcs()
    // The probe already answered, so the section's repo load is not sent again.
    useGitHubStore().available = true
  })
}

function service(provisioning?: ServiceProvisioning): Block {
  return { ...authService, ...(provisioning ? { provisioning } : {}) }
}

const handlers = (customTypes = [registeredManifestType, workspaceManifestType]) =>
  apiResponse(listEnvironmentHandlersContract, {
    pathPrefix,
    body: { handlers: [kubernetesHandler], customTypes },
  })

async function openSection(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: /Test infrastructure/ }))
}

async function detect(canvasElement: HTMLElement) {
  await openSection(canvasElement)
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Detect from repo' }))
}

/** Open the section, then wait for what the story shows. */
function opensTo(shown: (canvas: ReturnType<typeof within>) => Promise<unknown>) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSection(canvasElement)
    await shown(within(canvasElement))
  }
}

const compose: ServiceProvisioning = {
  type: 'docker-compose',
  composePath: 'deploy/docker-compose.test.yml',
}

const meta = {
  title: 'Inspector/Components/ServiceTestConfig',
  component: ServiceTestConfig,
  args: { block: service(compose) },
  decorators: [seeded(compose)],
  parameters: { width: 'panel', api: [handlers()] },
} satisfies Meta<typeof ServiceTestConfig>
export default meta

type Story = StoryObj<typeof meta>

/** Docker Compose with its file: the nudge into the setup wizard, and Detect from repo. */
export const Default: Story = {
  play: opensTo(async (c) => {
    await c.findByTestId('env-setup-nudge')
    // Detect only proposes; Apply saves (see Detect Proposal), and the hint says so.
    await c.findByText(/Nothing is saved until you apply it/)
  }),
}

/** Nothing declared: the service reads as needing no infrastructure. */
export const Infraless: Story = {
  args: { block: service() },
  decorators: [seeded()],
  play: opensTo((c) => c.findByText('No infrastructure')),
}

const kubernetes: ServiceProvisioning = {
  type: 'kubernetes',
  manifestSource: {
    type: 'separate',
    repo: 'acme/platform-deploy',
    ref: 'main',
    path: 'services/auth/overlays/preview',
    renderer: 'kustomize',
  },
}

/** Kubernetes manifests in a separate repository, at a ref and a path, rendered with Kustomize. */
export const Kubernetes: Story = {
  args: { block: service(kubernetes) },
  decorators: [seeded(kubernetes)],
  play: opensTo((c) => c.findByDisplayValue('acme/platform-deploy')),
}

const custom: ServiceProvisioning = {
  type: 'custom',
  manifestId: registeredManifestType.manifestId,
  manifestPath: 'infra/preview',
}

/** A custom type the deployment registered, picked, with its manifest path. */
export const Custom: Story = {
  args: { block: service(custom) },
  decorators: [seeded(custom)],
  play: opensTo((c) => c.findByDisplayValue('infra/preview')),
}

/** Custom, on a deployment and workspace with no manifest types: the warning in place of a picker. */
export const CustomNoTypes: Story = {
  args: { block: service({ type: 'custom' }) },
  decorators: [seeded({ type: 'custom' })],
  parameters: { api: [handlers([])] },
  play: opensTo((c) =>
    c.findByText('No custom manifest types are defined yet. Add one in the Infrastructure window.'),
  ),
}

const kubernetesRecommendation: ProvisioningRecommendation = {
  detected: true,
  provisioning: {
    type: 'kubernetes',
    manifestSource: {
      type: 'colocated',
      path: 'deploy/k8s/overlays/preview',
      renderer: 'kustomize',
    },
  },
  urlSource: { source: 'ingressTemplate', hostTemplate: 'auth-{{env}}.preview.acme.dev' },
  namespace: 'auth-preview',
  overlayCandidates: [
    { path: 'deploy/k8s/overlays/preview', name: 'preview', recommended: true },
    { path: 'deploy/k8s/overlays/staging', name: 'staging', recommended: false },
  ],
  notes: [
    {
      field: 'manifestSource',
      confidence: 'high',
      message: 'kustomization.yaml under deploy/k8s ⇒ kustomize',
    },
    {
      field: 'urlSource',
      confidence: 'low',
      message: 'Ingress host in base/ingress.yaml looks templated; check the pattern',
    },
  ],
}

/**
 * Detect found Kubernetes manifests: the proposal with its path, the URL pattern and namespace it
 * read, and the notes with their confidence. Apply saves it, then the overlays to choose from show.
 */
export const DetectProposal: Story = {
  args: { block: service() },
  decorators: [seeded()],
  parameters: {
    api: [
      handlers(),
      ...boardApi(boardBlocks),
      apiResponse(detectServiceProvisioningContract, {
        pathPrefix,
        body: kubernetesRecommendation,
      }),
    ],
  },
  // The detected config is saved onto the block, so the story reads the block from the board
  // store, as the inspector does, rather than from a fixed argument.
  render: () => ({
    components: { ServiceTestConfig },
    setup() {
      const board = useBoardStore()
      return { live: computed(() => board.getBlock(authService.id)) }
    },
    template: '<ServiceTestConfig v-if="live" :block="live" />',
  }),
  play: async ({ canvasElement }) => {
    await detect(canvasElement)
    await within(canvasElement).findByText(
      'Manifests pin namespace "auth-preview"; recommend honoring it on the workspace handler.',
    )
    // Detect only proposes: the saved config is untouched until Apply.
    const canvas = within(canvasElement)
    await canvas.findByTestId('detect-proposal')
    await expect(useBoardStore().getBlock(authService.id)?.provisioning).toBeUndefined()
    await userEvent.click(canvas.getByTestId('detect-apply'))
    await waitFor(() =>
      expect(useBoardStore().getBlock(authService.id)?.provisioning?.type).toBe('kubernetes'),
    )
    // Applied: the overlay chips refine the saved config.
    await canvas.findByRole('button', { name: 'preview' })
  },
}

/** The repository could not be read: the backend's message under the button, as it came. */
export const DetectError: Story = {
  parameters: {
    api: [
      handlers(),
      apiRefusal(detectServiceProvisioningContract, {
        pathPrefix,
        status: 422,
        error: {
          code: 'validation',
          message:
            'Could not read acme/auth-service to auto-detect. Confirm the GitHub App still has ' +
            '"Contents: read" access to this repository (re-check the installation\'s repository ' +
            'access), that the branch exists, and that you are not rate-limited, then retry. ' +
            'Underlying error: Not Found',
        },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await detect(canvasElement)
    await within(canvasElement).findByText(/Underlying error: Not Found/)
  },
}

/** Open from the start, as the add-service modal renders it. */
export const OpenByDefault: Story = {
  args: { defaultOpen: true },
  // No click: the section is already open, and a click would close it.
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByTestId('env-setup-nudge')
  },
}
