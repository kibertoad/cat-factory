import type { Meta, StoryObj } from '@storybook/vue3'
import { forgotPasswordContract, passwordLoginContract } from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { apiNoContent, apiRefusal } from '~/stories/api'
import { withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import LoginScreen from './LoginScreen.vue'

// The sign-in screen. It offers the methods the backend reports in its auth config, which the
// auth store holds, so each story sets the store's flags in a seed. A sign-in that succeeds
// reloads the page (`window.location.assign`), so no story answers one with success: the failed
// sign-in story answers with the backend's own 401.
const meta = {
  title: 'Shell/Components/LoginScreen',
  component: LoginScreen,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof LoginScreen>
export default meta

type Story = StoryObj<typeof meta>

type Providers = ReturnType<typeof useAuthStore>['providers']

/** The sign-in methods a hosted deployment offers. Each story names the ones it turns on. */
function offer(providers: Partial<Providers>) {
  useAuthStore().providers = {
    github: false,
    password: false,
    google: false,
    sso: false,
    ...providers,
  }
}

const passwordAndOAuth = withSeed(() => offer({ password: true, github: true, google: true }))

/** Fill the password form. The fields have no labels, so the placeholders find them. */
async function fillPasswordForm(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await userEvent.type(canvas.getByPlaceholderText('Email'), 'maya@acme.dev')
  await userEvent.type(canvas.getByPlaceholderText('Password'), 'not-my-password')
}

/** Password sign-in under the GitHub and Google buttons, with links to sign up and to reset. */
export const Default: Story = {
  decorators: [passwordAndOAuth],
}

/** Sign up: the form gains a name field, and the link goes back to sign in. */
export const SignUp: Story = {
  decorators: [passwordAndOAuth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Sign up' }))
    await canvas.findByPlaceholderText('Name (optional)')
  },
}

/** Forgot password: one email field. The OAuth buttons go away. */
export const ForgotPassword: Story = {
  decorators: [passwordAndOAuth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Forgot password?' }))
    await canvas.findByText('Reset your password.')
  },
}

/**
 * After the reset link is requested. The backend answers 204 whether the address is registered
 * or not, so the screen says the same in both cases.
 */
export const ForgotSent: Story = {
  decorators: [passwordAndOAuth],
  parameters: { api: [apiNoContent(forgotPasswordContract, { pathPrefix: '/auth' })] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Forgot password?' }))
    await userEvent.type(canvas.getByPlaceholderText('Email'), 'maya@acme.dev')
    await userEvent.click(canvas.getByRole('button', { name: 'Send reset link' }))
    await canvas.findByText(/If an account exists/)
  },
}

/** A wrong password: the backend's 401 message shows above the button. */
export const SignInFailed: Story = {
  decorators: [passwordAndOAuth],
  parameters: {
    api: [
      apiRefusal(passwordLoginContract, {
        pathPrefix: '/auth',
        status: 401,
        error: { code: 'unauthorized', message: 'Invalid email or password' },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await fillPasswordForm(canvasElement)
    await userEvent.click(canvas.getByTestId('login-submit'))
    await canvas.findByTestId('login-error')
  },
}

/**
 * Enterprise SSO first, with the label the operator set (`AUTH_SSO_LABEL`), then the password
 * form.
 */
export const Sso: Story = {
  decorators: [
    withSeed(() => {
      offer({ sso: true, password: true })
      useAuthStore().sso = { label: 'Acme Okta', protocol: 'oidc' }
    }),
  ],
}

/** An SSO round trip that came back refused: the user is in no allowed directory group. */
export const SsoError: Story = {
  decorators: [
    withSeed(() => {
      offer({ sso: true, password: true })
      const auth = useAuthStore()
      auth.sso = { label: 'Acme Okta', protocol: 'oidc' }
      auth.ssoError = 'group_required'
    }),
  ],
}

/**
 * A hosted deployment that accepts the user's own personal access token for GitHub and GitLab:
 * the provider switch, the token field and a link to create a token.
 */
export const RemotePat: Story = {
  decorators: [
    withSeed(() => {
      offer({ github: true })
      useAuthStore().patProviders = ['github', 'gitlab']
    }),
  ],
}

/** Local mode with a GitHub token in `.env`: one click signs in as its owner. */
export const LocalMode: Story = {
  decorators: [
    withSeed(() => {
      useAuthStore().localMode = {
        enabled: true,
        patLogin: { configured: ['github'], installable: [] },
      }
    }),
  ],
}

/**
 * Local mode with no token yet: a warning, and a form to paste one, which also becomes the token
 * the deployment pushes with.
 */
export const LocalModeSetup: Story = {
  decorators: [
    withSeed(() => {
      useAuthStore().localMode = {
        enabled: true,
        patLogin: { configured: [], installable: ['github', 'gitlab'] },
      }
    }),
  ],
}

/** A local node in mothership mode: sign in through the hosted mothership, above the token. */
export const Mothership: Story = {
  decorators: [
    withSeed(() => {
      useAuthStore().localMode = {
        enabled: true,
        mothership: true,
        mothershipUrl: 'https://cats.acme.dev',
        patLogin: { configured: ['github'], installable: [] },
      }
    }),
  ],
}

/** A hosted deployment that offers no way to sign in: a warning instead of an empty card. */
export const NoSignInMethod: Story = {
  decorators: [withSeed(() => offer({}))],
}
