import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, screen, spyOn, userEvent, waitFor } from 'storybook/test'
import FailureMessage from './FailureMessage.vue'

// The SPA's one inline failure render: a title naming what failed, the translated description,
// and the server's own text with its request id behind "Show details". The failure is the value
// `describeFailure` makes from a 500, written out so the request id shows.
const meta = {
  title: 'Primitives/Components/FailureMessage',
  component: FailureMessage,
  args: {
    title: 'Usage could not be loaded.',
    failure: {
      descriptionKey: 'errors.generic.description.internal',
      message: 'Internal server error',
      issues: [],
      requestId: '7f3c2a10-5b9e-4c1d-9a64-2e8f0b6d4c31',
    },
  },
} satisfies Meta<typeof FailureMessage>
export default meta

type Story = StoryObj<typeof meta>

/** Folded: the translated copy, with the server's text one click away. */
export const Default: Story = {}

/** "Show details" opens the server's text and the request id under the description. */
export const DetailShown: Story = {
  play: async () => {
    await userEvent.click(await screen.findByTestId('failure-message-show-detail'))
    await expect(screen.getByTestId('failure-message-detail')).toHaveTextContent(
      'Internal server error · Request ID 7f3c2a10-5b9e-4c1d-9a64-2e8f0b6d4c31',
    )
  },
}

/**
 * "Copy details" copies the same report as the failure toast: the title, the description, and the
 * detail with its request id, so the id can be pasted rather than retyped.
 */
export const CopyDetails: Story = {
  play: async () => {
    // The clipboard seam writes through the Clipboard API when the browser allows it, and
    // otherwise selects the text in a hidden textarea and runs the `copy` command (the path this
    // headless browser takes). Catch the text on either path.
    const copied: string[] = []
    spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
      copied.push(text)
    })
    spyOn(document, 'execCommand').mockImplementation((command) => {
      const textarea = [...document.body.querySelectorAll('textarea')].at(-1)
      if (command === 'copy' && textarea) copied.push(textarea.value)
      return true
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Copy details' }))
    await waitFor(() =>
      expect(copied).toContain(
        'Usage could not be loaded.\n' +
          'Something went wrong on the server. Try again, and share the details with your ' +
          'deployment operator if it keeps happening.\n' +
          'Internal server error · Request ID 7f3c2a10-5b9e-4c1d-9a64-2e8f0b6d4c31',
      ),
    )
  },
}

/** No detail to show: the description and the copy action, with no "Show details". */
export const NoDetail: Story = {
  args: {
    title: undefined,
    failure: {
      descriptionKey: 'errors.generic.description.network',
      message: null,
      issues: [],
      requestId: null,
    },
  },
}
