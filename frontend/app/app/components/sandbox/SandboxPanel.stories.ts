import type { Meta, StoryObj } from '@storybook/vue3'
import {
  getSandboxExperimentContract,
  listWorkspaceModelsContract,
  sandboxOverviewContract,
  type SandboxExperiment,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen, userEvent } from 'storybook/test'
import { apiFailure, apiPending, apiRefusal, apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import { claudeOnlyCatalog, modelOption } from '~/stories/providers.stories.mocks'
import {
  olderSandboxExperiments,
  sandboxAgentKinds,
  sandboxExperiment,
  sandboxExperimentDetail,
  sandboxFixtures,
  sandboxPrompts,
} from '~/stories/sandbox.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import SandboxPanel from './SandboxPanel.vue'

// The Sandbox window: a place to test prompt versions and models against graded fixtures, away
// from the board. Experiments builds a matrix for one agent kind (prompt versions, models,
// fixtures), runs it and shows the graded grid; Prompts forks a shipped prompt into a candidate
// and versions it; Fixtures lists the graded inputs. The window loads the Sandbox overview and the
// board's model catalog each time it opens, so each story answers those reads. A deployment with
// no Sandbox database answers 503. The tabs and rows are clicked, as a person does.

const pathPrefix = storyWorkspacePrefix

/** Kimi K2.7 on Workers AI and Claude Opus 5, both usable. */
const models = [modelOption(), claudeOnlyCatalog[2]!]

function overviewIs(experiments: SandboxExperiment[]): HttpHandler {
  return apiResponse(sandboxOverviewContract, {
    pathPrefix,
    body: {
      agentKinds: sandboxAgentKinds,
      prompts: sandboxPrompts,
      fixtures: sandboxFixtures,
      experiments,
      maxCells: 100,
    },
  })
}

const modelCatalog = apiResponse(listWorkspaceModelsContract, {
  pathParams: { workspaceId: STORY_WORKSPACE_ID },
  body: models,
})

const meta = {
  title: 'Settings/Components/SandboxPanel',
  component: SandboxPanel,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useUiStore().openSandbox()
    }),
  ],
  parameters: {
    api: [overviewIs([sandboxExperiment, ...olderSandboxExperiments]), modelCatalog],
  },
} satisfies Meta<typeof SandboxPanel>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The builder for requirements review, with the baseline and both built-in fixtures ticked and no
 * model yet, the note that the coder cannot run here, and three past experiments.
 */
export const Default: Story = {}

/** No experiment yet. */
export const Empty: Story = {
  parameters: { api: [overviewIs([]), modelCatalog] },
}

/** The overview still loading: placeholder panels. */
export const Loading: Story = {
  parameters: { api: [apiPending(sandboxOverviewContract, { pathPrefix }), modelCatalog] },
}

/** A deployment with no Sandbox database: the note naming what to provision. */
export const Unavailable: Story = {
  parameters: {
    api: [
      apiRefusal(sandboxOverviewContract, {
        pathPrefix,
        status: 503,
        error: { code: 'unavailable', message: 'The Sandbox is not configured.' },
      }),
      modelCatalog,
    ],
  },
}

/** The overview read failed: the error, with Retry. */
export const Error: Story = {
  parameters: { api: [apiFailure(sandboxOverviewContract, { pathPrefix }), modelCatalog] },
}

/**
 * The finished experiment opened, with the candidate's cell on Claude selected: four cells, one
 * failed, and the judge's scores for the selected one.
 */
export const ExperimentDetail: Story = {
  parameters: {
    api: [
      overviewIs([sandboxExperiment, ...olderSandboxExperiments]),
      modelCatalog,
      apiResponse(getSandboxExperimentContract, {
        pathPrefix,
        pathParams: { experimentId: sandboxExperiment.id },
        body: sandboxExperimentDetail,
      }),
    ],
  },
  play: async () => {
    await userEvent.click(
      await screen.findByRole('button', { name: /Edge cases first vs baseline/ }),
    )
    // The candidate's first row is its cell on Claude.
    const [onClaude] = await screen.findAllByText('Edge cases first@v2')
    await userEvent.click(onClaude!)
    await screen.findByText('gap_coverage')
  },
}

/** The Prompts tab, with the candidate open for a new version. */
export const Prompts: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('tab', { name: 'Prompts' }))
    // The baselines are offered a fork instead, so the candidate's is the first Edit.
    const [candidate] = await screen.findAllByRole('button', { name: 'Edit / version' })
    await userEvent.click(candidate!)
    await screen.findByText(/New version of · /)
  },
}

/** The Fixtures tab: three built-ins with their expected findings, and a custom one. */
export const Fixtures: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('tab', { name: 'Fixtures' }))
    // Only the Fixtures tab shows where a fixture comes from.
    await screen.findByText('custom')
  },
}
