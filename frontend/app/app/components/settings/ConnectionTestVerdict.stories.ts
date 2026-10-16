import type { Meta, StoryObj } from '@storybook/vue3'
import ConnectionTestVerdict from './ConnectionTestVerdict.vue'

// The verdict of a "Test connection" probe. A failure with a known cause shows the cause as
// translated copy, with the backend's English message under it; without a cause, the message is
// the headline. A null result (no probe yet) renders nothing, so there is no story for it.
const meta = {
  title: 'Settings/Components/ConnectionTestVerdict',
  component: ConnectionTestVerdict,
  parameters: { width: 'panel' },
} satisfies Meta<typeof ConnectionTestVerdict>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { result: { ok: true, message: 'Reached in 142 ms.' } } }

/** Nothing is listening at the address. */
export const Refused: Story = {
  args: {
    result: { ok: false, failureCause: 'refused', message: 'connect ECONNREFUSED 127.0.0.1:11434' },
  },
}

/** A host name that does not resolve. */
export const DnsFailure: Story = {
  args: { result: { ok: false, failureCause: 'dns', message: 'getaddrinfo ENOTFOUND ollama.lan' } },
}

/** An untrusted certificate. Expired and wrong-host certificates have their own causes. */
export const UntrustedCertificate: Story = {
  args: {
    result: {
      ok: false,
      failureCause: 'tls-untrusted',
      message: 'unable to verify the first certificate',
    },
  },
}

/** A failure with no cause: the backend's message is the headline. */
export const UnclassifiedFailure: Story = {
  args: { result: { ok: false, message: 'The provider answered 500 with an empty body.' } },
}
