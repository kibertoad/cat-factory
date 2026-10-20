import type { Meta, StoryObj } from '@storybook/vue3'
import type { Decorator } from '@storybook/vue3'
import { computed, h, inject, provide, type Ref } from 'vue'
import { reactiveSlotsKey } from '@modular-vue/runtime'
import type { WorkspaceMetadataFieldDefinition } from '~/modular/workspace-metadata'
import type { AppSlots } from '~/modular/slots'
import { withSeed } from '~/stories/withStores'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'
import WorkspaceMetadataSettings from './WorkspaceMetadataSettings.vue'

// The values a board gives the custom fields its deployment declares in code: a game studio's
// deployment asks each board which game it builds, so a tool link can open on that game. The
// fields come from the `workspaceMetadataFields` slot of the app registry, which no first-party
// module fills, so a decorator adds them to the slots this story's components see. The values
// come from the board's stored settings. The deployment, its fields and the values are made up.
// No story shows a select field: its not-set item has the value '', and Reka's SelectItem throws
// for an empty value, so Storybook shows its error display (#2393).
const studioFields: WorkspaceMetadataFieldDefinition[] = [
  { key: 'maxPlayers', label: 'Players per match', type: 'number', placeholder: '8' },
  {
    key: 'editorProject',
    label: 'Map editor project',
    placeholder: 'proj-0000',
    description: 'The project id in the studio map editor.',
  },
]

/** Replace the `workspaceMetadataFields` slot with `fields`, whatever the app's registry resolved. */
function withMetadataFields(fields: WorkspaceMetadataFieldDefinition[]): Decorator {
  return (story) => {
    const Story = story()
    return {
      setup() {
        const resolved = inject(reactiveSlotsKey) as Ref<AppSlots>
        provide(
          reactiveSlotsKey,
          computed(() => ({ ...resolved.value, workspaceMetadataFields: fields })),
        )
        return () => h(Story)
      },
    }
  }
}

const meta = {
  title: 'Settings/Components/WorkspaceMetadataSettings',
  component: WorkspaceMetadataSettings,
  decorators: [
    withMetadataFields(studioFields),
    withSeed(() => {
      const store = useWorkspaceSettingsStore()
      store.settings = {
        ...store.settings,
        metadata: { maxPlayers: '12', editorProject: 'proj-4471' },
      }
    }),
  ],
  parameters: { width: 'prose' },
} satisfies Meta<typeof WorkspaceMetadataSettings>
export default meta

type Story = StoryObj<typeof meta>

/** A number and a text field, each filled from the board's stored values. */
export const Default: Story = {}

/**
 * Every declared key is malformed, so every field is dropped: the empty state. A deployment that
 * declared no fields has no such tab, but the copy says the deployment defines no fields.
 */
export const Empty: Story = {
  decorators: [
    withMetadataFields([
      { key: '1st-game', label: 'Game' },
      { key: 'map editor', label: 'Map editor project' },
    ]),
  ],
}
