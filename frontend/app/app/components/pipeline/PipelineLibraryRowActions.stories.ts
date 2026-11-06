import type { Meta, StoryObj } from '@storybook/vue3'
import type { Pipeline } from '~/types/domain'
import { standardBuild } from '~/stories/pipelines.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import PipelineLibraryRowActions from './PipelineLibraryRowActions.vue'

// The actions on one row of the pipeline library. A built-in offers archive, its approval
// checkpoints and clone; a custom pipeline offers archive, clone, edit and delete. The two default
// claims join them in the advanced interface.
const custom: Pipeline = {
  ...standardBuild,
  id: 'pl_7',
  name: 'Standard build (copy)',
  builtin: undefined,
  isDefault: undefined,
  version: undefined,
}

const meta = {
  title: 'Pipeline/Components/PipelineLibraryRowActions',
  component: PipelineLibraryRowActions,
  args: { pipeline: standardBuild },
  decorators: [withSeed(() => seedSnapshot(snapshot({ pipelines: [standardBuild, custom] })))],
} satisfies Meta<typeof PipelineLibraryRowActions>
export default meta

type Story = StoryObj<typeof meta>

/** The built-in Standard build. */
export const Default: Story = {}

/** A copy of it, which edits in the builder. */
export const Custom: Story = { args: { pipeline: custom } }
