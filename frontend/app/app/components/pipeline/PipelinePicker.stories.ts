import type { Meta, StoryObj } from '@storybook/vue3'
import { ref } from 'vue'
import { userEvent, within } from 'storybook/test'
import { adaptiveBuild, bugfixPipeline, standardBuild } from '~/stories/pipelines.stories.mocks'
import PipelinePicker from './PipelinePicker.vue'

// The pipeline picker the add-task modal, the inspector's run settings and the recurring schedule
// use: a popover with the pipelines on the left and, on the right, the steps of the one hovered or
// selected. Some callers add a row for picking none. The selection is a `v-model`, so the stories
// keep it in a local ref. The labels are the ones the add-task modal and the schedule modal pass.
const meta = {
  title: 'Pipeline/Components/PipelinePicker',
  component: PipelinePicker,
  args: {
    modelValue: standardBuild.id,
    options: [standardBuild, adaptiveBuild, bugfixPipeline],
    noneLabel: 'Choose at run time',
  },
  render: (args) => ({
    components: { PipelinePicker },
    setup: () => ({ args, selected: ref(args.modelValue) }),
    template: '<div class="pb-96"><PipelinePicker v-bind="args" v-model="selected" /></div>',
  }),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('pipeline-picker-trigger'))
  },
} satisfies Meta<typeof PipelinePicker>
export default meta

type Story = StoryObj<typeof meta>

/** Standard build selected, and its eleven steps in the preview. */
export const Default: Story = {}

/** The none row selected: the preview says the pipeline is chosen at run time. */
export const NoneSelected: Story = { args: { modelValue: '' } }

/**
 * A schedule must have a pipeline, so there is no none row: the trigger shows the prompt and the
 * preview asks for a hover.
 */
export const WithoutNoneRow: Story = {
  args: { modelValue: '', noneLabel: undefined, placeholder: 'Pick a pipeline' },
}

/** The closed trigger with the selected pipeline's name. */
export const Closed: Story = {
  render: (args) => ({
    components: { PipelinePicker },
    setup: () => ({ args, selected: ref(args.modelValue) }),
    template: '<PipelinePicker v-bind="args" v-model="selected" />',
  }),
  play: async () => {},
}
