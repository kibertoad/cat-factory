import type { Meta, StoryObj } from '@storybook/vue3'
import {
  adaptiveBuild,
  bugfixPipeline,
  reproTestKind,
  standardBuild,
} from '~/stories/pipelines.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { withSnapshot } from '~/stories/withStores'
import PipelinePreview from './PipelinePreview.vue'

// What a pipeline does, read-only: its name, its description and every step it runs in order,
// with the steps that stop for a person and the steps that run only on some tasks marked. The
// pickers show it beside their list. The pipelines are copies of the backend's built-ins.
//
// Triage and fix runs a `repro-test` step. That kind is registered in the backend and reaches the
// SPA through the snapshot's `customAgentKinds`, so the stories seed it. Every other step is a
// kind the SPA ships.
const meta = {
  title: 'Pipeline/Components/PipelinePreview',
  component: PipelinePreview,
  parameters: { width: 'panel' },
  args: { pipeline: standardBuild },
  decorators: [withSnapshot(snapshot({ customAgentKinds: [reproTestKind] }))],
} satisfies Meta<typeof PipelinePreview>
export default meta

type Story = StoryObj<typeof meta>

/** Standard build: eleven steps, the two testers each run only for their side of the service. */
export const Default: Story = {}

/** Triage and fix: the triage step stops for a person, so the preview counts one gate. */
export const WithGates: Story = { args: { pipeline: bugfixPipeline } }

/** Adaptive build: the design, the testers and the human review run only on bigger tasks. */
export const WithConditions: Story = { args: { pipeline: adaptiveBuild } }

/** A pipeline with no description: the steps follow the name directly. */
export const NoDescription: Story = {
  args: { pipeline: { ...bugfixPipeline, description: undefined } },
}
