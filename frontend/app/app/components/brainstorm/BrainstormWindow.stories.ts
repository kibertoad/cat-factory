import type { Meta, StoryObj } from '@storybook/vue3'
import type { BrainstormItem, BrainstormSession, BrainstormStage } from '@cat-factory/contracts'
import { getBrainstormContract } from '@cat-factory/contracts'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { boardBlocks, logoutTask } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import BrainstormWindow from './BrainstormWindow.vue'

// The brainstorm window, where a run parks on a brainstorm step: the agent proposes options with
// their trade-offs, and the person chooses some, steers them in a reply, and dismisses the rest.
// When every option is settled they ask to incorporate, and a background pass folds the choices
// into one document, the direction the next stage reads. The requirements and architecture
// stages share the window. It loads the block's session for the stage when it opens, so each
// story opens it on Log out everywhere and answers that read. The counts and the actions are in
// a rail that shows from the lg width. The document sections follow the companion's prompt
// (`prompts/brainstorm.ts` in agents); the options and the documents are made up.

const START = Date.UTC(2026, 9, 12, 9)

function option(
  id: string,
  title: string,
  detail: string,
  overrides: Partial<BrainstormItem> = {},
): BrainstormItem {
  return {
    id,
    category: 'question',
    severity: 'medium',
    title,
    detail,
    status: 'open',
    reply: null,
    createdAt: START,
    updatedAt: START,
    ...overrides,
  }
}

const families = option(
  'bi_families',
  'Revoke every token family',
  'Revoke every refresh token family the user holds. Simple and complete, but a phone that is ' +
    'offline keeps a valid access token until it expires (15 minutes).',
  { severity: 'high', category: 'clarification' },
)
const currentDevice = option(
  'bi_current_device',
  'Keep the current device signed in',
  'Revoke every family except the one making the request. People expect this from other ' +
    'products, but it needs the request to name its family.',
)
const emailNotice = option(
  'bi_email',
  'Email the user when it happens',
  'Send one email after the revocation. It helps if an attacker triggers it, but it adds a ' +
    'dependency on the mail service.',
  { severity: 'low', category: 'gap' },
)
const adminAction = option(
  'bi_admin',
  'Let an admin do it for a user',
  'The same action from the admin console. Useful for support, but it needs an audit row and ' +
    'a permission of its own.',
  { category: 'assumption' },
)

/** One option chosen with a reply, one dismissed, two still open. */
const halfway: BrainstormItem[] = [
  { ...families, status: 'answered', reply: 'Yes, all of them. 15 minutes is acceptable.' },
  currentDevice,
  { ...emailNotice, status: 'dismissed' },
  adminAction,
]

/** Every option settled: three chosen, one dismissed. */
const settled: BrainstormItem[] = [
  halfway[0]!,
  { ...currentDevice, status: 'answered', reply: 'Yes. The account page sends its family id.' },
  halfway[2]!,
  { ...adminAction, status: 'answered', reply: 'Later, but plan the permission now.' },
]

const direction =
  '## Goal\n\n' +
  'A user can end every session they hold from the account page, so a lost phone stops ' +
  'working within 15 minutes.\n\n' +
  '## In Scope\n\n' +
  '- Revoke every refresh token family of the user except the current one.\n' +
  '- A `sessions.revokeAll` permission, granted to admins, for a later console action.\n\n' +
  '## Out of Scope\n\n' +
  '- Emailing the user.\n\n' +
  '## Decisions & Rationale\n\n' +
  '- Access tokens are not revoked: they expire within 15 minutes, and checking a list on ' +
  'every request costs more than that window.\n\n' +
  '## Open Risks / Follow-ups\n\n' +
  '- Mobile clients older than 4.2 do not send a family id, so they sign themselves out too.'

function session(overrides: Partial<BrainstormSession> = {}): BrainstormSession {
  return {
    id: 'bs_logout_requirements',
    blockId: logoutTask.id,
    stage: 'requirements',
    status: 'ready',
    items: halfway,
    model: 'workers-ai:@cf/zai-org/glm-5.2',
    convergedDirection: null,
    iteration: 1,
    maxIterations: 3,
    rev: 3,
    createdAt: START,
    updatedAt: START + 12 * 60_000,
    ...overrides,
  }
}

function sessionIs(body: BrainstormSession | null, stage: BrainstormStage = 'requirements') {
  return apiResponse(getBrainstormContract, {
    pathPrefix: storyWorkspacePrefix,
    pathParams: { blockId: logoutTask.id, stage },
    body,
  })
}

function opened(stage: BrainstormStage) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    useUiStore().openBrainstorm(logoutTask.id, stage)
  })
}

const meta = {
  title: 'Review/Pages/BrainstormWindow',
  component: BrainstormWindow,
  decorators: [opened('requirements')],
  parameters: { api: [sessionIs(session())] },
} satisfies Meta<typeof BrainstormWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The first pass: four options by severity, one chosen with a reply, one dismissed and two open,
 * so the rail asks for a choice on each before it incorporates.
 */
export const Default: Story = {}

/** The session read in flight: three placeholder cards. */
export const Loading: Story = {
  parameters: {
    api: [
      apiPending(getBrainstormContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { blockId: logoutTask.id, stage: 'requirements' },
      }),
    ],
  },
}

/** No session for this block and stage. */
export const Empty: Story = { parameters: { api: [sessionIs(null)] } }

/**
 * The session read failed: the store treats any failure as the feature being off and keeps no
 * session, so the window shows the same empty state as no session.
 */
export const LoadFailed: Story = {
  parameters: {
    api: [
      apiFailure(getBrainstormContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { blockId: logoutTask.id, stage: 'requirements' },
      }),
    ],
  },
}

/** Every option settled and the choices sent: a banner while the background pass folds them in. */
export const Incorporating: Story = {
  parameters: { api: [sessionIs(session({ status: 'incorporating', items: settled }))] },
}

/**
 * The choices are folded into a draft document, below the options. The rail offers another pass
 * against it, or a redo of the folding with a direction.
 */
export const Merged: Story = {
  parameters: {
    api: [sessionIs(session({ status: 'merged', items: settled, convergedDirection: direction }))],
  },
}

/** Settled: a banner, and the document the requirements review reads next. */
export const Incorporated: Story = {
  parameters: {
    api: [
      sessionIs(
        session({
          status: 'incorporated',
          items: settled,
          convergedDirection: direction,
          iteration: 2,
        }),
      ),
    ],
  },
}

/**
 * The third pass of three still raised an option: the person picks one more round, going on
 * anyway, or stopping and resetting the task.
 */
export const Exceeded: Story = {
  parameters: {
    api: [
      sessionIs(
        session({
          status: 'exceeded',
          iteration: 3,
          convergedDirection: direction,
          items: [
            ...settled,
            option(
              'bi_web_sockets',
              'Close open live connections',
              'Revoked tokens do not close a WebSocket that is already open. Closing them ' +
                'needs the gateway to know which family each connection uses.',
              { severity: 'high', category: 'risk' },
            ),
          ],
        }),
      ),
    ],
  },
}

/** The architecture stage: the same window with its own title, icon and options. */
export const Architecture: Story = {
  decorators: [opened('architecture')],
  parameters: {
    api: [
      sessionIs(
        session({
          id: 'bs_logout_architecture',
          stage: 'architecture',
          items: [
            option(
              'bi_family_table',
              'A table of revoked families',
              'One row per revoked family, read on every refresh. Small and fast, but it grows ' +
                'until a sweep deletes rows older than the longest refresh lifetime.',
              { severity: 'high' },
            ),
            option(
              'bi_family_column',
              'A revoked flag on each family',
              'One column on `token_families`. Nothing extra to sweep, but revoking every ' +
                'family of a user writes many rows in one statement.',
            ),
          ],
        }),
        'architecture',
      ),
    ],
  },
}
