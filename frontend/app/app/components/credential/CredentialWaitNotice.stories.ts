import type { Meta, StoryObj } from '@storybook/vue3'
import CredentialWaitNotice from './CredentialWaitNotice.vue'

// A run parked because a credential a step needs is missing. A lapsed personal credential resumes
// on the cached personal password (the prompt opens when there is none); a missing capability
// credential names what to store and how to obtain it, and any member resumes once it is stored.
const meta = {
  title: 'Pipeline/Components/CredentialWaitNotice',
  component: CredentialWaitNotice,
  parameters: { width: 'panel' },
  args: {
    executionId: 'exec_login',
    initiatedBy: null,
    wait: { subject: 'personal', raisedAt: 1 },
  },
} satisfies Meta<typeof CredentialWaitNotice>
export default meta

type Story = StoryObj<typeof meta>

/** The parked run, with the explanation and the resume button. */
export const Default: Story = {}

/** The compact form in the step detail rail, without the explanation. */
export const Compact: Story = { args: { compact: true } }

/** Seen by someone other than the run's initiator: no prompt, only who can resume it. */
export const SomeoneElsesRun: Story = { args: { initiatedBy: 'usr_someone_else' } }

/** A research step waiting on a vendor login the workspace has not stored. */
export const MissingCapabilityCredential: Story = {
  args: {
    wait: {
      subject: 'capability',
      raisedAt: 1,
      key: 'VENDOR_LOGIN',
      declaredBy: { kind: 'project-definition', id: 'research/acme:vendor' },
      label: 'Vendor admin login',
      onboarding: {
        url: 'https://app.vendor.example/settings/users',
        instructions:
          'Invite a service user with the Admin role and store its username and password.',
      },
      observed: 'The partner API settings page requires an admin session.',
    },
  },
}
