import type { Meta, StoryObj } from '@storybook/vue3'
import { modelPreset } from '~/stories/policies.stories.mocks'
import { claudeOnlyCatalog } from '~/stories/providers.stories.mocks'
import { seedModelCatalog, withSeed } from '~/stories/withStores'
import { useModelPresetsStore } from '~/stores/modelPresets'
import { useUiStore } from '~/stores/ui'
import type { ModelPreset } from '~/types/model-presets'
import AiPresetMismatchDialog from './AiPresetMismatchDialog.vue'

// The dialog the board opens once per session when the workspace has models it can run, but its
// default model preset assigns models it cannot. Tasks fall back to that preset, so they would
// start on a model that fails. It names the models, and offers to edit the presets or connect
// more vendors. The catalog here has only the Claude subscription connected, and the built-in
// default preset is all Kimi K2.7, which needs Workers AI.
function opened(preset: ModelPreset) {
  return withSeed(() => {
    seedModelCatalog(claudeOnlyCatalog)
    useModelPresetsStore().hydrate([preset])
    useUiStore().openAiPresetMismatch()
  })
}

const meta = {
  title: 'Setup/Components/AiPresetMismatchDialog',
  component: AiPresetMismatchDialog,
  decorators: [opened(modelPreset())],
} satisfies Meta<typeof AiPresetMismatchDialog>
export default meta

type Story = StoryObj<typeof meta>

/** The default preset, Kimi K2.7, assigns one model the workspace cannot run. */
export const Default: Story = {}

/**
 * A preset with two overrides the workspace cannot run either: GLM-5.3, and a model id that is
 * not in the catalog at all, which shows as the raw id.
 */
export const SeveralModels: Story = {
  decorators: [
    opened(
      modelPreset({
        name: 'Team default',
        overrides: { coder: 'glm-5.3', 'pr-reviewer': 'qwen3.6-max' },
      }),
    ),
  ],
}
