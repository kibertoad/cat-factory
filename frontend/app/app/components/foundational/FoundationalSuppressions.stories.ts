import type { Meta, StoryObj } from '@storybook/vue3'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { suppressions } from '~/stories/foundational.stories.mocks'
import { seedFoundationalCatalog, withSeed } from '~/stories/withStores'
import FoundationalSuppressions from './FoundationalSuppressions.vue'

// What a board or an account has opted out of: each hidden service, with Restore. A hidden
// service is not in the merged catalog, so this list is the only way back to it. A tombstone that
// hides nothing now says so. The section renders only when something is hidden. The stories seed
// the list the manager would load.
const meta = {
  title: 'Settings/Components/FoundationalSuppressions',
  component: FoundationalSuppressions,
  args: { kind: 'workspace', ownerId: STORY_WORKSPACE_ID },
  decorators: [withSeed(() => seedFoundationalCatalog({ suppressions }))],
  parameters: { width: 'prose' },
} satisfies Meta<typeof FoundationalSuppressions>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A board hides the account's search service, and keeps a tombstone for a mailer the account has
 * since withdrawn, which shows its id and says it hides nothing.
 */
export const Default: Story = {}

/** An account hides the audit log the deployment registers in code. */
export const Account: Story = {
  args: { kind: 'account', ownerId: orgAccount.id },
  decorators: [
    withSeed(() =>
      seedFoundationalCatalog(
        {
          suppressions: [
            {
              id: 'audit-log',
              name: 'Audit log',
              summary: 'Records who did what, for the compliance export.',
              inherited: true,
            },
          ],
        },
        orgAccount.id,
      ),
    ),
  ],
}
