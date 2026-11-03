import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent } from 'storybook/test'
import ConnectionTestVerdict from './ConnectionTestVerdict.vue'

// The verdict of a "Test connection" probe. A failure with a known cause shows the cause as
// translated copy, with the backend's English message under it; without a cause, the message is
// the headline. When the test CALL itself failed there is no verdict, so the failure is shown the
// way a failure toast words it. A null result (no probe yet) renders nothing, so there is no story
// for it.
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

/**
 * The test call itself failed, so there is no probe verdict: "Connection failed", the translated
 * copy for the failure, and the server's text behind "Show details".
 */
export const CallFailed: Story = {
  args: {
    result: {
      ok: false,
      failure: {
        descriptionKey: 'errors.generic.description.internal',
        message: 'Internal server error',
        issues: [],
        requestId: '7f3c2a10-5b9e-4c1d-9a64-2e8f0b6d4c31',
        reason: null,
      },
    },
  },
  play: async () => {
    await screen.findByText('Connection failed')
    await userEvent.click(screen.getByTestId('failure-message-show-detail'))
    await screen.findByText(/Internal server error · Request ID 7f3c2a10/)
  },
}
