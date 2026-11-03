import { getServiceTestSecretsContract } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import ServiceTestSecrets from './ServiceTestSecrets.vue'

// A service's sealed test credentials: tokens a tester needs, delivered to its container out of
// band and never put in a prompt. The panel loads the configured names itself; values are never
// read back, so every value must be entered again and Save stays disabled until each row has one.
// Saving replaces the whole set. The header always carries the warning icon, and the section
// starts open. When the deployment has no secret store the section is hidden.

const secretsFor = (entries: { key: string; description: string }[]) =>
  apiResponse(getServiceTestSecretsContract, {
    pathPrefix: storyWorkspacePrefix,
    pathParams: { blockId: authService.id },
    body: { blockId: authService.id, entries },
  })

const meta = {
  title: 'Inspector/Components/ServiceTestSecrets',
  component: ServiceTestSecrets,
  args: { block: authService },
  decorators: [
    withSeed(() => {
      seedBoard(boardBlocks)
      seedWorkspace()
    }),
  ],
  parameters: {
    width: 'panel',
    api: [
      secretsFor([
        { key: 'STRIPE_API_KEY', description: 'Test-mode key for the billing flows.' },
        { key: 'SENDGRID_API_KEY', description: 'Sends the sign-in emails.' },
      ]),
    ],
  },
} satisfies Meta<typeof ServiceTestSecrets>
export default meta

type Story = StoryObj<typeof meta>

/** Two secrets configured: their names come back, their values do not. */
export const Default: Story = {}

/** None configured: one blank row. */
export const Empty: Story = { parameters: { api: [secretsFor([])] } }
