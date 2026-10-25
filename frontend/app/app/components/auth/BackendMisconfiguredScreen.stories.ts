import type { Meta, StoryObj } from '@storybook/vue3'
import { withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import BackendMisconfiguredScreen from './BackendMisconfiguredScreen.vue'

// The full screen the SPA shows when the backend booted into its fallback because a required
// variable is missing or invalid. It reads the problems from the auth store. The text below has
// the shape of the backend's help for two variables (`ENV_HELP` in `server/src/config/problems.ts`),
// but it is the story's own copy, not a quote. The remedies mark commands with Markdown backticks, which
// the screen renders as code spans. Reload reloads the Storybook frame.
const meta = {
  title: 'Shell/Components/BackendMisconfiguredScreen',
  component: BackendMisconfiguredScreen,
  parameters: { layout: 'fullscreen' },
  decorators: [
    withSeed(() => {
      useAuthStore().misconfigured = {
        problems: [
          {
            key: 'DATABASE_URL',
            summary:
              'Postgres connection string. The Node service stores ALL of its state (workspaces, boards, runs, credentials) there.',
            remedy:
              'Set DATABASE_URL to your Postgres URL, e.g. `postgres://user:password@localhost:5432/cat_factory`. In local mode, `docker compose up` in deploy/local starts one and prints the URL.',
            docsUrl:
              'https://github.com/kibertoad/cat-factory/blob/main/docs/environment-variables.md#core-service--networking',
          },
          {
            key: 'AUTH_SESSION_SECRET',
            summary:
              'HMAC key that signs the session, proxy, and machine tokens, and the whole auth surface trusts it.',
            remedy:
              'Set AUTH_SESSION_SECRET to a random string of at least 32 characters. Generate one with `pnpm secrets` (deploy/local) or `openssl rand -hex 32`. It must stay STABLE across restarts: a fresh value forces every user to re-login.',
            docsUrl:
              'https://github.com/kibertoad/cat-factory/blob/main/docs/environment-variables.md#authentication',
          },
        ],
      }
    }),
  ],
} satisfies Meta<typeof BackendMisconfiguredScreen>
export default meta

type Story = StoryObj<typeof meta>

/** Two missing variables, each with how to fix it and a link to its documentation. */
export const Default: Story = {}
