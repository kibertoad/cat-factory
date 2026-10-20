import type { Meta, StoryObj } from '@storybook/vue3'
import type { ToolServerProbeResult, ToolServerView } from '@cat-factory/contracts'
import { withSeed } from '~/stories/withStores'
import { useToolServersStore } from '~/stores/toolServers'
import ToolServerChecklist from './ToolServerChecklist.vue'

// The deployment's tool servers (MCP): for each, which agent kinds get it, which harnesses can
// serve its transport, the credentials it needs, its OAuth grant when it has one, and a Test that
// speaks the protocol to it. Each row names every reason the server might never reach a run. The
// section renders only when the deployment registers a server, so there is no story for none. The
// stories seed the inventory and any test result, so nothing is loaded. Nuxt UI is the server the
// deployment can register as shipped (`nuxt-ui` in agents); the tracker and docs servers are made up.
function server(overrides: Partial<ToolServerView> & Pick<ToolServerView, 'id' | 'label'>) {
  return {
    transport: 'http',
    target: 'https://ui.nuxt.com/mcp',
    declaredBy: ['coder', 'fixer', 'ci-fixer'],
    servableHarnesses: ['pi', 'claude-code'],
    credentials: [],
    probeable: true,
    ...overrides,
  } satisfies ToolServerView
}

const nuxtUi = server({
  id: 'nuxt-ui',
  label: 'Nuxt UI',
  guidance:
    'Look up a @nuxt/ui component’s real props, slots, events and examples with search-components / ' +
    'get-component before writing it, instead of guessing the API from the component name.',
})

const tracker = server({
  id: 'acme-tracker',
  label: 'Acme tracker',
  target: 'https://tracker.acme.dev/mcp',
  declaredBy: ['planner'],
  allowedTools: ['search_issues', 'get_issue'],
  credentials: [],
  oauth: { grant: 'authorization_code', connected: false },
})

const docs = server({
  id: 'acme-docs',
  label: 'Acme docs',
  target: 'https://docs.acme.dev/mcp',
  declaredBy: ['planner'],
  credentials: [{ key: 'ACME_DOCS_TOKEN', required: true }],
})

function seeded(servers: ToolServerView[], results: Record<string, ToolServerProbeResult> = {}) {
  return withSeed(() => {
    const store = useToolServersStore()
    store.view = { servers }
    store.results = results
    store.available = true
  })
}

const meta = {
  title: 'Settings/Components/ToolServerChecklist',
  component: ToolServerChecklist,
  decorators: [seeded([nuxtUi])],
  parameters: { width: 'prose' },
} satisfies Meta<typeof ToolServerChecklist>
export default meta

type Story = StoryObj<typeof meta>

/** Nuxt UI, given to the three coder kinds, tested: it answered with its tools. */
export const Default: Story = {
  decorators: [
    seeded([nuxtUi], {
      'nuxt-ui': {
        serverId: 'nuxt-ui',
        status: 'ok',
        serverName: 'nuxt-ui',
        serverVersion: '4.11.0',
        protocolVersion: '2025-06-18',
        toolCount: 9,
        toolsComplete: true,
      },
    }),
  ],
}

/**
 * A server no agent kind declares, served only over stdio: it can never reach a run, so the row
 * says so and Test is replaced by why it cannot be probed.
 */
export const Unattached: Story = {
  decorators: [
    seeded([
      server({
        id: 'internal-docs',
        label: 'Internal docs',
        transport: 'stdio',
        target: 'npx -y @acme/docs-mcp',
        declaredBy: [],
        servableHarnesses: ['pi', 'claude-code', 'codex'],
        credentials: [{ key: 'ACME_DOCS_TOKEN', required: true }],
        probeable: false,
        notProbeableReason: 'stdio_transport',
      }),
    ]),
  ],
}

/** A server that authorises by OAuth, not yet granted: Connect. */
export const OAuthNotConnected: Story = { decorators: [seeded([tracker])] }

/**
 * The same server, granted by Maya, without a refresh token: its scopes, the warning that it will
 * need granting again, and the last token error.
 */
export const OAuthConnected: Story = {
  decorators: [
    seeded([
      {
        ...tracker,
        oauth: {
          grant: 'authorization_code',
          connected: true,
          scopes: ['issues:read'],
          connectedAt: Date.UTC(2026, 9, 2),
          connectedBy: 'usr_maya',
          refreshable: false,
          lastError: 'invalid_grant: the refresh token has expired',
        },
      },
    ]),
  ],
}

/**
 * The same server, granted, tested: it answered, and one allowed tool matches nothing the server
 * offers.
 */
export const AllowedToolUnmatched: Story = {
  decorators: [
    seeded([{ ...tracker, oauth: { grant: 'authorization_code', connected: true } }], {
      'acme-tracker': {
        serverId: 'acme-tracker',
        status: 'ok',
        serverName: 'acme-tracker',
        serverVersion: '1.2.0',
        protocolVersion: '2025-06-18',
        toolCount: 1,
        tools: ['search_issues'],
        toolsComplete: true,
        allowedTools: {
          declared: ['search_issues', 'get_issue'],
          unmatched: ['get_issue'],
          checked: true,
        },
      },
    }),
  ],
}

/**
 * A server with a static credential, tested: it answered 401. The HTTP error status, and the
 * backend's detail behind Show details.
 */
export const ProbeFailed: Story = {
  decorators: [
    seeded([docs], {
      'acme-docs': {
        serverId: 'acme-docs',
        status: 'http_error',
        httpStatus: 401,
        error: 'POST https://docs.acme.dev/mcp answered 401: {"error":"invalid_token"}',
      },
    }),
  ],
}
