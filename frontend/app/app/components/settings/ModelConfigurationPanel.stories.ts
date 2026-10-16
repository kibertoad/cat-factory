import type { Meta, StoryObj } from '@storybook/vue3'
import {
  listVendorCredentialsContract,
  listWorkspaceModelsContract,
  type ModelPreset,
} from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import { modelPresetLibrary } from '~/stories/policies.stories.mocks'
import { presetModelCatalog, vendorCredential } from '~/stories/providers.stories.mocks'
import { seedUiMode, seedWorkspace, withSeed } from '~/stories/withStores'
import { useModelPresetsStore } from '~/stores/modelPresets'
import { useUiStore } from '~/stores/ui'
import ModelConfigurationPanel from './ModelConfigurationPanel.vue'

// The Model Configuration screen, a full-screen window: the board's model presets, each a base
// model for every agent with optional per-agent overrides, and the board's consensus groups under
// them. Edit opens a preset in the editor: the name, the base model, the default flag, the route
// order (advanced tier, or when the preset already states one) and the per-agent overrides. The
// presets come with the board snapshot, so each story seeds them; the window loads the board's
// model catalog and its subscription pool when it opens, so each story answers those two reads.
// The consensus groups are empty, so their section shows only in the advanced tier (their own
// stories have the library).

const catalog = apiResponse(listWorkspaceModelsContract, {
  pathParams: { workspaceId: STORY_WORKSPACE_ID },
  body: presetModelCatalog,
})

/** The Claude subscription in the pool, so Claude Opus 5 shows on its subscription route. */
const pool = apiResponse(listVendorCredentialsContract, {
  pathPrefix: storyWorkspacePrefix,
  body: { credentials: [vendorCredential()] },
})

/** The window opened on a board whose library is `presets`, in the `mode` tier. */
function opened(presets: ModelPreset[], mode: 'basic' | 'advanced' = 'basic') {
  return withSeed(() => {
    seedWorkspace()
    seedUiMode(mode)
    useModelPresetsStore().hydrate(presets)
    useUiStore().openModelConfig()
  })
}

const meta = {
  title: 'Settings/Pages/ModelConfigurationPanel',
  component: ModelConfigurationPanel,
  decorators: [opened(modelPresetLibrary)],
  parameters: { layout: 'fullscreen', api: [catalog, pool] },
} satisfies Meta<typeof ModelConfigurationPanel>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The four built-ins, Kimi the default, and the board's own preset with two overrides and a custom
 * route order.
 */
export const Default: Story = {}

/** No preset in the library. */
export const Empty: Story = { decorators: [opened([])] }

/** The model catalog still loading: placeholder rows. */
export const Loading: Story = {
  parameters: {
    api: [
      apiPending(listWorkspaceModelsContract, { pathParams: { workspaceId: STORY_WORKSPACE_ID } }),
      pool,
    ],
  },
}

/** The model catalog read failed: the alert with Retry, and the failure toast. */
export const Error: Story = {
  parameters: {
    api: [
      apiFailure(listWorkspaceModelsContract, { pathParams: { workspaceId: STORY_WORKSPACE_ID } }),
      pool,
    ],
  },
}

/**
 * The board's own preset opened in the basic tier: the route order shows, because the preset
 * states one, and the reviewers' two overrides.
 */
export const Editing: Story = {
  play: async () => {
    const edits = await screen.findAllByRole('button', { name: 'Edit preset' })
    await userEvent.click(edits[4]!)
  },
}

/** The Kimi built-in opened in the advanced tier: the route order, in the deployment's default. */
export const EditingAdvanced: Story = {
  decorators: [opened(modelPresetLibrary, 'advanced')],
  play: async () => {
    const [kimi] = await screen.findAllByRole('button', { name: 'Edit preset' })
    await userEvent.click(kimi!)
  },
}
