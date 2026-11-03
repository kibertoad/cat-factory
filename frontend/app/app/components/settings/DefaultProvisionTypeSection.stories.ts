import type { Meta, StoryObj } from '@storybook/vue3'
import type { CustomManifestType, ProvisionType } from '@cat-factory/contracts'
import { registeredManifestType } from '~/stories/infra.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useInfraConfigStore } from '~/stores/infraConfig'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'
import DefaultProvisionTypeSection from './DefaultProvisionTypeSection.vue'

// How a board's new services get their test environments by default: no infrastructure, Docker
// Compose, Kubernetes, Cloudflare, or a custom provider the deployment or the board registered.
// It only suggests a type for services added later, and nothing is saved until Save. With nothing
// saved and a registered provider, it preselects that provider and says it is only a suggestion.
// Each story seeds the board's saved choice and the custom types, so nothing loads.
function seeded(
  saved: { type: ProvisionType | null; manifestId?: string | null },
  types: CustomManifestType[],
) {
  return withSeed(() => {
    seedWorkspace()
    const settings = useWorkspaceSettingsStore()
    settings.settings = {
      ...settings.settings,
      defaultProvisionType: saved.type,
      defaultProvisionManifestId: saved.manifestId ?? null,
    }
    const infra = useInfraConfigStore()
    infra.customTypes = types
    infra.available = true
  })
}

const meta = {
  title: 'Settings/Components/DefaultProvisionTypeSection',
  component: DefaultProvisionTypeSection,
  decorators: [seeded({ type: 'docker-compose' }, [])],
  parameters: { width: 'prose' },
} satisfies Meta<typeof DefaultProvisionTypeSection>
export default meta

type Story = StoryObj<typeof meta>

/** Docker Compose saved: picked, with Save off and the line that says it is saved. */
export const Default: Story = {}

/** Nothing saved and no custom provider: no type picked. */
export const Unset: Story = { decorators: [seeded({ type: null }, [])] }

/**
 * Nothing saved, and the deployment registers a Terraform provider: it is preselected, with the
 * line that says it is only a suggestion until saved.
 */
export const Suggested: Story = { decorators: [seeded({ type: null }, [registeredManifestType])] }

/** Custom saved, but no custom provider is registered any more: the warning in place of a list. */
export const CustomNoTypes: Story = {
  decorators: [seeded({ type: 'custom', manifestId: 'terraform-stack' }, [])],
}
