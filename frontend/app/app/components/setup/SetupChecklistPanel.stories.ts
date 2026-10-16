import type { Meta, StoryObj } from '@storybook/vue3'
import type { GitHubPatCheck, InfraSetup, WorkspaceSnapshot } from '@cat-factory/contracts'
import { getGitHubConnectionContract, listWorkspaceModelsContract } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiFailure, apiPending } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import { githubProbeApi } from '~/stories/githubApi'
import { claudeOnlyCatalog } from '~/stories/providers.stories.mocks'
import { providerProbeApi } from '~/stories/setupApi'
import { buildPipeline, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedMember, seedModelCatalog, seedSnapshot, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import { useWorkspaceStore } from '~/stores/workspace'
import SetupChecklistPanel from './SetupChecklistPanel.vue'

// The setup checklist: each thing a task needs before it can run and merge (a model, source
// control, an agent runner, and the optional test environments and content storage), its state,
// and one button per row. Below it, the advisories: a newer version of a pipeline, a new built-in one. Opening it asks
// the model catalog, the GitHub probe and the two infrastructure providers again, so every story
// answers those reads (`githubProbeApi`, `providerProbeApi`). The infrastructure status is the
// snapshot's `infraSetup`, seeded here. A row the viewer cannot fix says who can instead. Each
// story seeds its own board, because a seed in the meta would run under every story's own.
const configured: InfraSetup = {
  agentExecutor: 'configured',
  ephemeralEnvironments: 'configured',
  binaryStorage: 'configured',
}

interface Setup {
  infra?: InfraSetup | null
  models?: boolean
  snapshot?: Partial<WorkspaceSnapshot>
  member?: boolean
}

/** The checklist open on the story board, with the probes the story does not answer already in. */
function opened(setup: Setup = {}) {
  return withSeed(() => {
    seedSnapshot(snapshot(setup.snapshot))
    if (setup.models !== false) seedModelCatalog(claudeOnlyCatalog)
    const workspace = useWorkspaceStore()
    if (setup.infra !== null) {
      workspace.ready = true
      workspace.infraSetup = setup.infra ?? configured
    }
    if (setup.member) {
      seedMember()
      workspace.infraSetupOwners = {
        agentExecutor: 'operator',
        ephemeralEnvironments: 'workspace_admin',
        binaryStorage: 'workspace_admin',
      }
    }
    useUiStore().openSetupChecklist()
  })
}

function probes(
  options: { connected?: boolean; patCheck?: GitHubPatCheck; environmentMissing?: string[] } = {},
): HttpHandler[] {
  return [
    ...githubProbeApi({ connected: options.connected, patCheck: options.patCheck }),
    ...providerProbeApi({ environmentMissing: options.environmentMissing }),
  ]
}

const meta = {
  title: 'Setup/Components/SetupChecklistPanel',
  component: SetupChecklistPanel,
  parameters: { api: probes() },
} satisfies Meta<typeof SetupChecklistPanel>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A new board: the model is done, GitHub and the runner are missing, the test environment
 * provider misses its token, and the deployment has no content storage. The first required gap,
 * GitHub, has the one solid button.
 */
export const Default: Story = {
  decorators: [
    opened({
      infra: {
        agentExecutor: 'not_defined',
        ephemeralEnvironments: 'configured',
        binaryStorage: 'not_applicable',
      },
    }),
  ],
  parameters: { api: probes({ connected: false, environmentMissing: ['apiToken'] }) },
}

/** Everything a task needs is in: four of four, and each row offers Change. */
export const AllDone: Story = {
  decorators: [opened({ infra: { ...configured, binaryStorage: 'not_applicable' } })],
}

/** No probe has answered yet: each row and the count say Checking. */
export const Checking: Story = {
  decorators: [opened({ infra: null, models: false })],
  parameters: {
    api: [
      apiPending(listWorkspaceModelsContract, { pathParams: { workspaceId: STORY_WORKSPACE_ID } }),
      apiPending(getGitHubConnectionContract, { pathPrefix: storyWorkspacePrefix }),
      ...probes(),
    ],
  },
}

/** The model catalog did not load: the model row says the answer is unknown, with Retry. */
export const ModelLoadFailed: Story = {
  decorators: [opened({ models: false })],
  parameters: {
    api: [
      apiFailure(listWorkspaceModelsContract, { pathParams: { workspaceId: STORY_WORKSPACE_ID } }),
      ...probes(),
    ],
  },
}

/** The person's own token cannot push: the source control row needs attention, and says whose. */
export const TokenUnderscoped: Story = {
  decorators: [opened()],
  parameters: {
    api: probes({
      patCheck: {
        state: 'checked',
        report: {
          source: 'initiator',
          kind: 'classic',
          capabilities: { push: 'missing', pullRequests: 'granted', workflows: 'granted' },
          probedRepos: ['acme/auth-service'],
          deniedRepos: [],
          unprobedRepoCount: 0,
          webUrl: 'https://github.com',
        },
      },
    }),
  },
}

/**
 * A member on a new board: no buttons, and each gap says who can close it. The deployment's
 * operator sets up the runner; a board admin does the rest.
 */
export const NotAdmin: Story = {
  decorators: [
    opened({
      member: true,
      infra: { ...configured, agentExecutor: 'not_defined', ephemeralEnvironments: 'not_defined' },
    }),
  ],
  parameters: { api: probes({ connected: false }) },
}

/**
 * Everything is in, and the advisories have work: a newer version of the Build pipeline and a
 * new built-in pipeline the board does not have.
 */
export const Advisories: Story = {
  decorators: [
    opened({
      snapshot: {
        pipelines: [{ ...buildPipeline, builtin: true, version: 2 }],
        pipelineCatalogVersions: { pl_build: 3, pl_bugfix: 1 },
        pipelineCatalogNames: { pl_build: 'Build', pl_bugfix: 'Bug fix' },
      },
    }),
  ],
}
