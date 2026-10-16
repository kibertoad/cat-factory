import type { Meta, StoryObj } from '@storybook/vue3'
import { resetPasswordContract } from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { apiNoContent, apiRefusal } from '~/stories/api'
import { withSeed } from '~/stories/withStores'
import ResetPasswordScreen from './ResetPasswordScreen.vue'

// The page a password reset email links to (`/reset-password?token=…`). It reads the token from
// the page URL, so each story sets or removes a `token` parameter on the Storybook frame's URL
// before the screen mounts. The frame keeps its URL between stories, which is why the missing
// token story removes it rather than leaving it out. "Go to sign in" and "Back to sign in" load
// `/`, which leaves Storybook.
const meta = {
  title: 'Shell/Components/ResetPasswordScreen',
  component: ResetPasswordScreen,
  parameters: { layout: 'fullscreen' },
  decorators: [withResetToken('rst_9f2c41d07ab8')],
} satisfies Meta<typeof ResetPasswordScreen>
export default meta

type Story = StoryObj<typeof meta>

/** Put `token` on the frame's URL, or remove it when null. */
function withResetToken(token: string | null) {
  return withSeed(() => {
    const url = new URL(window.location.href)
    if (token === null) url.searchParams.delete('token')
    else url.searchParams.set('token', token)
    window.history.replaceState(window.history.state, '', url)
  })
}

/** Type a new password in both fields and submit. */
async function submit(canvasElement: HTMLElement, password: string, confirm = password) {
  const canvas = within(canvasElement)
  await userEvent.type(canvas.getByPlaceholderText('New password'), password)
  await userEvent.type(canvas.getByPlaceholderText('Confirm new password'), confirm)
  await userEvent.click(canvas.getByRole('button', { name: 'Reset password' }))
}

/** The new and confirm fields. */
export const Default: Story = {}

/** A link with no token: the screen says so and offers the way back. */
export const MissingToken: Story = {
  decorators: [withResetToken(null)],
}

/**
 * A password under 8 characters. The screen checks length and match itself, before it sends
 * anything.
 */
export const ValidationError: Story = {
  play: async ({ canvasElement }) => {
    await submit(canvasElement, 'short')
    await within(canvasElement).findByText('Password must be at least 8 characters.')
  },
}

/** A used or expired token: the backend's 400 message shows under the fields. */
export const InvalidLink: Story = {
  parameters: {
    api: [
      apiRefusal(resetPasswordContract, {
        pathPrefix: '/auth',
        status: 400,
        error: {
          code: 'validation',
          message: 'This password reset link is invalid or has expired.',
        },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await submit(canvasElement, 'correct-horse-battery')
    await within(canvasElement).findByText('This password reset link is invalid or has expired.')
  },
}

/** The password is set: the form gives way to a confirmation and a sign-in button. */
export const Done: Story = {
  parameters: { api: [apiNoContent(resetPasswordContract, { pathPrefix: '/auth' })] },
  play: async ({ canvasElement }) => {
    await submit(canvasElement, 'correct-horse-battery')
    await within(canvasElement).findByRole('button', { name: 'Go to sign in' })
  },
}
