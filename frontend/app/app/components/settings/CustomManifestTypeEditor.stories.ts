import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { registeredManifestType, workspaceManifestType } from '~/stories/infra.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useInfraConfigStore } from '~/stores/infraConfig'
import type { CustomManifestType } from '@cat-factory/contracts'
import CustomManifestTypeEditor from './CustomManifestTypeEditor.vue'

// The catalog of custom provision types a service can pin: the ones the deployment registered
// in code (read only) and the ones the workspace defined (edit and remove), above the form that
// adds or edits a workspace type. Each story seeds the infrastructure store's types.
const withTypes = (types: CustomManifestType[]) =>
  withSeed(() => {
    useInfraConfigStore().customTypes = types
  })

const meta = {
  title: 'Settings/Components/CustomManifestTypeEditor',
  component: CustomManifestTypeEditor,
  parameters: { width: 'prose' },
  decorators: [withTypes([registeredManifestType, workspaceManifestType])],
} satisfies Meta<typeof CustomManifestTypeEditor>
export default meta

type Story = StoryObj<typeof meta>

/** A registered type and a workspace type with its edit and remove buttons, above the add form. */
export const Default: Story = {}

/** No custom types: the empty state above the add form. */
export const Empty: Story = { decorators: [withTypes([])] }

/**
 * The workspace type in edit mode, opened with its edit button: the id is fixed, so the form
 * names it in the heading instead of offering the field, and Cancel shows.
 */
export const Editing: Story = {
  play: async ({ canvasElement }) => {
    const row = within(canvasElement).getByText(workspaceManifestType.label).closest('li')!
    await userEvent.click(within(row as HTMLElement).getAllByRole('button')[0]!)
    await within(canvasElement).findByRole('button', { name: 'Cancel' })
  },
}
