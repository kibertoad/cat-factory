import type { Meta, StoryObj } from '@storybook/vue3'
import CredentialWaitNotice from './CredentialWaitNotice.vue'

// A run whose personal-subscription credential lapsed before a step could dispatch. Its one
// action resumes the step: the cached personal password re-mints the credential, and the
// password prompt opens when there is none.
const meta = {
  title: 'Pipeline/Components/CredentialWaitNotice',
  component: CredentialWaitNotice,
  parameters: { width: 'panel' },
  args: { executionId: 'exec_login', initiatedBy: null },
} satisfies Meta<typeof CredentialWaitNotice>
export default meta

type Story = StoryObj<typeof meta>

/** The parked run, with the explanation and the resume button. */
export const Default: Story = {}

/** The compact form in the step detail rail, without the explanation. */
export const Compact: Story = { args: { compact: true } }

/** Seen by someone other than the run's initiator: no prompt, only who can resume it. */
export const SomeoneElsesRun: Story = { args: { initiatedBy: 'usr_someone_else' } }
