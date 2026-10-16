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
} satisfies Meta<typeof ServiceValidationConfig>
export default meta

type Story = StoryObj<typeof meta>

/**
 * `InspectorSection` opens closed, so each play opens it first and then waits for what the story
 * shows.
 */
function opensTo(shown: (canvas: ReturnType<typeof within>) => Promise<unknown>) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await userEvent.click(await within(canvasElement).findByTestId('inspector-section-toggle'))
    await shown(within(canvasElement))
  }
}

/** An install command and three checks. */
export const Default: Story = {
  play: opensTo((c) => c.findByDisplayValue('pnpm install --frozen-lockfile')),
}

/** Nothing configured for this service: the empty state. */
export const Empty: Story = {
  parameters: { api: [configsAre([])] },
  play: opensTo((c) => c.findByTestId('validation-empty')),
}
