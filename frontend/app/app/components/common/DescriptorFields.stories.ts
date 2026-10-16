import type { Meta, StoryObj } from '@storybook/vue3'
import { ref } from 'vue'
import { userEvent, within } from 'storybook/test'
import type { DescriptorField, DescriptorFieldValues } from '~/types/domain'
import DescriptorFields from './DescriptorFields.vue'

// The form a deployment declares for a preset or a reusable operation, rendered from its field
// descriptors: one input per field type, optional section captions, and fields that show only
// when another field has a value. Labels and help are the deployment's own words, shown as
// written. The fields are made up, as a dependency bump operation might declare them. The render
// keeps the values, so typing changes what the story shows. No story for zero fields: the
// component then draws nothing.
const fields: DescriptorField[] = [
  { key: 'package', label: 'Package', required: true, placeholder: 'e.g. react' },
  { key: 'version', label: 'Target version', required: true, placeholder: 'e.g. 19.2.0' },
  {
    key: 'registry',
    label: 'Registry',
    type: 'select',
    options: [
      { value: 'npmjs', label: 'npmjs.com' },
      { value: 'github', label: 'GitHub Packages' },
    ],
  },
  {
    key: 'workspaces',
    label: 'Workspaces to update',
    type: 'checkbox-group',
    options: [
      { value: 'web', label: 'web' },
      { value: 'api', label: 'api' },
      { value: 'worker', label: 'worker' },
    ],
  },
  { key: 'allowMajor', label: 'Allow a major upgrade', type: 'checkbox' },
  {
    key: 'attempts',
    label: 'Fix attempts',
    type: 'number',
    min: 1,
    max: 10,
    integer: true,
    help: 'How many times the agent may try to fix what the upgrade breaks.',
  },
  {
    key: 'lockfileDir',
    label: 'Lockfile directory',
    type: 'path',
    help: 'Relative to the repository root.',
  },
  { key: 'npmToken', label: 'Registry token', type: 'password' },
  { key: 'notes', label: 'Notes for the agent', type: 'textarea', maxLength: 2000 },
]

const values: DescriptorFieldValues = {
  package: 'react',
  version: '19.2.0',
  registry: 'npmjs',
  workspaces: ['web', 'worker'],
  allowMajor: true,
  attempts: 3,
  lockfileDir: 'apps/web',
  npmToken: 'npm_0000000000000000',
  notes: 'Keep the legacy context API until the auth pages move to hooks.',
}

const meta = {
  title: 'Primitives/Components/DescriptorFields',
  component: DescriptorFields,
  parameters: { width: 'panel' },
  args: { fields, modelValue: values },
  render: (args) => ({
    components: { DescriptorFields },
    setup() {
      const model = ref<DescriptorFieldValues>(args.modelValue)
      return { args, model }
    },
    template: '<DescriptorFields :fields="args.fields" v-model="model" />',
  }),
} satisfies Meta<typeof DescriptorFields>
export default meta

type Story = StoryObj<typeof meta>

/** One field of every type, filled in. */
export const Default: Story = {}

/** The same fields under two section captions. */
export const Sections: Story = {
  args: {
    fields: fields.map((field, i) => ({ ...field, section: i < 4 ? 'What to bump' : 'How' })),
  },
}

/**
 * A field that shows only when another has a value: the reason field appears once Allow a major
 * upgrade is switched on.
 */
export const ShowWhenRevealed: Story = {
  args: {
    fields: [
      fields[0]!,
      { key: 'allowMajor', label: 'Allow a major upgrade', type: 'checkbox' },
      {
        key: 'majorReason',
        label: 'Why a major upgrade is safe',
        type: 'textarea',
        showWhen: { key: 'allowMajor', equals: true },
      },
    ],
    modelValue: { package: 'react' },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('switch'))
    await canvas.findByText('Why a major upgrade is safe')
  },
}

/** A path that leaves the repository: the inline error. */
export const InvalidPath: Story = {
  args: { modelValue: { ...values, lockfileDir: '../shared' } },
}
