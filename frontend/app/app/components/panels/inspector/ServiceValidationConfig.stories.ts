import { listServiceValidationConfigsContract } from '@cat-factory/contracts'
import type { ServiceValidationConfig as ValidationConfig } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import ServiceValidationConfig from './ServiceValidationConfig.vue'

// The check commands the harness runs against a service's checkout before a PR may open: an
// optional install command, a list of labelled commands, and how many attempts a run gets. The
// panel loads every service's configuration itself. When the deployment has no validation store
// the section is hidden. It starts closed, so each story opens it.
const configsAre = (configs: ValidationConfig[]) =>
  apiResponse(listServiceValidationConfigsContract, {
    pathPrefix: storyWorkspacePrefix,
    body: configs,
  })

const meta = {
  title: 'Inspector/Components/ServiceValidationConfig',
  component: ServiceValidationConfig,
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
      configsAre([
        {
          blockId: authService.id,
          dependencyInstall: 'pnpm install --frozen-lockfile',
          checks: [
            { label: 'typecheck', command: 'pnpm typecheck' },
            { label: 'lint', command: 'pnpm lint' },
            { label: 'test', command: 'pnpm test:run' },
          ],
          maxAttempts: 3,
        },
      ]),
    ],
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('inspector-section-toggle'))
  },
} satisfies Meta<typeof ServiceValidationConfig>
export default meta

type Story = StoryObj<typeof meta>

/** An install command and three checks. */
export const Default: Story = {}

/** Nothing configured for this service: the empty state. */
export const Empty: Story = { parameters: { api: [configsAre([])] } }
