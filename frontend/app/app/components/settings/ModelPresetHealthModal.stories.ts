import type { Meta, StoryObj } from '@storybook/vue3'
import {
  modelPreset,
  modelPresetCatalogNames,
  modelPresetCatalogVersions,
} from '~/stories/policies.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useModelPresetsStore } from '~/stores/modelPresets'
import { useUiStore } from '~/stores/ui'
import type { ModelPreset } from '~/types/model-presets'
import ModelPresetHealthModal from './ModelPresetHealthModal.vue'

// The advisory the board opens once per session when the built-in model presets moved ahead of
// the board's copies. A catalog id with no copy on the board is new (Add); a copy below its
// catalog version is outdated (Reseed). The finding happens in the SPA, from the presets and the
// catalog versions the snapshot carries, so each story seeds those and opens the modal.
//
// The scenario is the real one the catalog produces: `mdp_claude` went to version 2 when it
// rolled from Opus 4.8 to Opus 5, and `mdp_chatgpt` arrived after older boards were seeded.
const kimi = modelPreset()
const glm = modelPreset({ id: 'mdp_glm', name: 'GLM-5.2', baseModelId: 'glm', isDefault: false })
const claudeV1 = modelPreset({
  id: 'mdp_claude',
  name: 'Claude Opus 4.8',
  baseModelId: 'claude-opus',
  isDefault: false,
})
const claude = { ...claudeV1, name: 'Claude Opus 5', version: 2 }
const chatgpt = modelPreset({
  id: 'mdp_chatgpt',
  name: 'GPT-5.6 Sol',
  baseModelId: 'gpt-5.6-sol',
  isDefault: false,
})

const opened = (presets: ModelPreset[]) =>
  withSeed(() => {
    useModelPresetsStore().hydrate(presets, modelPresetCatalogVersions, modelPresetCatalogNames)
    useUiStore().openModelPresetHealth()
  })

const meta = {
  title: 'Board/Components/ModelPresetHealthModal',
  component: ModelPresetHealthModal,
} satisfies Meta<typeof ModelPresetHealthModal>
export default meta

type Story = StoryObj<typeof meta>

/** GPT-5.6 Sol to add, Claude to update from version 1 to 2, and Reseed all for both. */
export const Default: Story = { decorators: [opened([kimi, glm, claudeV1])] }

/** Every built-in current: the all-valid line and Done. */
export const Empty: Story = { decorators: [opened([kimi, glm, claude, chatgpt])] }

/** Only Claude to update: one section, and no Reseed all for a single preset. */
export const OnlyOutdated: Story = { decorators: [opened([kimi, glm, claudeV1, chatgpt])] }
