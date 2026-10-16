import type { Meta, StoryObj } from '@storybook/vue3'
import {
  listTrackerBoardsContract,
  runBugHuntContract,
  type BugHuntCandidate,
  type BugHuntResult,
  type TaskSourceKind,
  type TaskSourceState,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen, userEvent } from 'storybook/test'
import { apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks, gatewayService } from '~/stories/board.stories.mocks'
import { githubLoadApi } from '~/stories/githubApi'
import { taskSources } from '~/stories/integrations.stories.mocks'
import { seedBoard, seedVcs, seedWorkspace, withSeed } from '~/stories/withStores'
import { useTasksStore } from '~/stores/tasks'
import { useUiStore } from '~/stores/ui'
import BugHuntModal from './BugHuntModal.vue'

// The bug hunt: pick a tracker and a board, and the platform ranks the board's open, unassigned
// bugs by impact against how hard each looks to fix. Pick this adopts one as a bug task and starts
// the bug-fix pipeline; no story answers that. A repo-backed tracker (GitHub Issues) has no board
// of its own: it reads the repository of the service the hunt is for. The trackers are the shared
// ones (GitHub Issues and Jira connected, Linear not), which the shell probes and the stories
// seed. The result stories click Hunt, as a person does. Not storied: the line that asks for a
// service frame first, since every story board has one.
const pathPrefix = storyWorkspacePrefix

/** Jira's projects, as `parseJiraBoards` lists them: the key is the board id. */
const jiraBoards = [
  { id: 'AUTH', name: 'Auth', key: 'AUTH' },
  { id: 'GW', name: 'API Gateway', key: 'GW' },
  { id: 'WEB', name: 'Web app', key: 'WEB' },
]

function candidate(overrides: Partial<BugHuntCandidate> = {}): BugHuntCandidate {
  return {
    source: 'jira',
    externalId: 'AUTH-142',
    title: 'Sessions survive a password change',
    url: 'https://acme.atlassian.net/browse/AUTH-142',
    status: 'To Do',
    type: 'Bug',
    priority: 'High',
    labels: ['security', 'sessions'],
    description: 'After a password change, tokens issued before the change still refresh.',
    createdAt: '2026-09-28T09:14:00Z',
    commentCount: 3,
    analysis: null,
    ...overrides,
  }
}

/** Three bugs on the AUTH board, best first, with the score the backend computes. */
const rankedCandidates: BugHuntCandidate[] = [
  candidate({
    analysis: {
      impact: 5,
      complexity: 2,
      score: 2.5,
      confidence: 'high',
      rationale:
        'Every account that changes its password stays exposed, and the fix is one revocation ' +
        'call in the password change handler.',
      recommended: true,
    },
  }),
  candidate({
    externalId: 'AUTH-151',
    title: 'Login form accepts a trailing space in the email',
    url: 'https://acme.atlassian.net/browse/AUTH-151',
    priority: 'Medium',
    labels: ['login'],
    createdAt: '2026-10-02T15:40:00Z',
    commentCount: 1,
    analysis: {
      impact: 2,
      complexity: 1,
      score: 2,
      confidence: 'medium',
      rationale: 'Users get a wrong-password error; trimming the input fixes it.',
      recommended: false,
    },
  }),
  candidate({
    externalId: 'AUTH-133',
    title: 'Refresh tokens rotate twice under concurrent requests',
    url: 'https://acme.atlassian.net/browse/AUTH-133',
    priority: null,
    labels: ['sessions', 'race'],
    createdAt: '2026-09-11T11:02:00Z',
    commentCount: 0,
    analysis: {
      impact: 3,
      complexity: 4,
      score: 0.75,
      confidence: 'low',
      rationale:
        'Logs some users out at random. The race is in the token store and is not yet understood.',
      recommended: false,
    },
  }),
]

function result(overrides: Partial<BugHuntResult> = {}): BugHuntResult {
  return {
    source: 'jira',
    board: 'AUTH',
    analysisStatus: 'ranked',
    model: 'anthropic:claude-opus-5',
    candidates: rankedCandidates,
    scanned: rankedCandidates.length,
    truncated: false,
    ...overrides,
  }
}

function huntAnswer(source: TaskSourceKind, body: BugHuntResult): HttpHandler {
  return apiResponse(runBugHuntContract, { pathPrefix, pathParams: { source }, body })
}

function boardsAnswer(source: TaskSourceKind = 'jira'): HttpHandler {
  return apiResponse(listTrackerBoardsContract, {
    pathPrefix,
    pathParams: { source },
    body: { source, boards: jiraBoards },
  })
}

/** The hunt, opened on `containerId` with `source` picked, over the shared trackers. */
function opened({
  source = 'jira',
  containerId = authService.id,
  sources = taskSources,
}: {
  source?: TaskSourceKind | null
  containerId?: string
  sources?: TaskSourceState[]
} = {}) {
  return withSeed(() => {
    seedBoard(boardBlocks)
    seedWorkspace()
    seedVcs()
    const tasks = useTasksStore()
    tasks.available = true
    tasks.sources = sources
    useUiStore().openBugHunt(source, containerId)
  })
}

async function pickBoard(name: string) {
  await userEvent.click(await screen.findByRole('combobox', { name: 'Board' }))
  await userEvent.click(await screen.findByRole('option', { name }))
}

async function hunt() {
  await userEvent.click(await screen.findByRole('button', { name: 'Hunt' }))
}

const meta = {
  title: 'Board/Components/BugHuntModal',
  component: BugHuntModal,
} satisfies Meta<typeof BugHuntModal>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A hunt of Jira's AUTH board for Auth Service: three bugs, best first, each with its score, its
 * ratings and the model's reason, and the first one recommended.
 */
export const Default: Story = {
  decorators: [opened()],
  parameters: { api: [boardsAnswer(), huntAnswer('jira', result())] },
  play: async () => {
    await pickBoard('Auth (AUTH)')
    await hunt()
    await screen.findByText(/AUTH-142/)
  },
}

/** A hunt that found nothing open and unassigned on the board. */
export const Empty: Story = {
  decorators: [opened()],
  parameters: {
    api: [
      boardsAnswer(),
      huntAnswer(
        'jira',
        result({ analysisStatus: 'empty', model: null, candidates: [], scanned: 0 }),
      ),
    ],
  },
  play: async () => {
    await pickBoard('Auth (AUTH)')
    await hunt()
    await screen.findByText('No open, unassigned bugs matched on this board.')
  },
}

/** No tracker connected: a button for each one the deployment offers to connect. */
export const NoTrackerConnected: Story = {
  decorators: [
    opened({ source: null, sources: taskSources.map((s) => ({ ...s, available: false })) }),
  ],
}

/**
 * GitHub Issues, which reads the repository of the service the hunt is for: the board is
 * acme/auth-service, stated with no control, and Hunt is ready.
 */
export const RepoBacked: Story = {
  decorators: [opened({ source: 'github' })],
  parameters: { api: githubLoadApi() },
}

/**
 * GitHub Issues for API Gateway, which has no repository linked: the hunt is refused, and the
 * warning shows under the board it names.
 */
export const RepoNotLinked: Story = {
  decorators: [opened({ source: 'github', containerId: gatewayService.id })],
  parameters: {
    api: [
      ...githubLoadApi(),
      apiRefusal(runBugHuntContract, {
        pathPrefix,
        pathParams: { source: 'github' },
        status: 400,
        error: {
          code: 'validation',
          message:
            'This service is not linked to a repository. Link it to a repo before reading its issues.',
          details: { reason: 'repo_not_linked' },
        },
      }),
    ],
  },
  play: async () => {
    await hunt()
    await screen.findByText(/This service has no repository linked/)
  },
}

/** A tracker a deployment registers, which can search for bugs but cannot list its boards. */
const helpdesk: TaskSourceState = {
  source: 'acme:helpdesk',
  label: 'Acme Helpdesk',
  icon: 'i-lucide-life-buoy',
  credentialFields: [],
  refLabel: 'Ticket id',
  refPlaceholder: 'HD-1234',
  searchable: true,
  available: true,
  enabled: true,
  ridesVcsProvider: null,
  supportsIntake: true,
  ignoredIntakePredicates: ['issueType'],
  repoBacked: false,
}

/**
 * That tracker picked: it cannot list its boards, so the board is typed in, and it has no issue
 * types, so the type filter is replaced by a line that says so.
 */
export const BoardsUnsupported: Story = {
  decorators: [opened({ source: helpdesk.source, sources: [...taskSources, helpdesk] })],
  parameters: {
    api: [
      apiRefusal(listTrackerBoardsContract, {
        pathPrefix,
        pathParams: { source: helpdesk.source },
        status: 400,
        error: {
          code: 'validation',
          message: `The '${helpdesk.source}' source cannot list boards on this deployment.`,
          details: { reason: 'boards_unsupported' },
        },
      }),
    ],
  },
}

/** No rating model on the deployment: the bugs in the board's order, each one Not assessed. */
export const Unranked: Story = {
  decorators: [opened()],
  parameters: {
    api: [
      boardsAnswer(),
      huntAnswer(
        'jira',
        result({
          analysisStatus: 'unavailable',
          model: null,
          candidates: rankedCandidates.map((c) => ({ ...c, analysis: null })),
        }),
      ),
    ],
  },
  play: async () => {
    await pickBoard('Auth (AUTH)')
    await hunt()
    await screen.findByText(/AUTH-142/)
  },
}

/**
 * The first 40 open bugs of a bigger board, the most one hunt reads (`BUG_HUNT_SCAN_LIMIT`). Past
 * the three above, the bugs are numbered fillers the model left unrated, which sort last.
 */
const firstForty: BugHuntCandidate[] = [
  ...rankedCandidates,
  ...Array.from({ length: 37 }, (_, i) =>
    candidate({
      externalId: `AUTH-${160 + i}`,
      title: `Reported bug ${i + 1}`,
      url: `https://acme.atlassian.net/browse/AUTH-${160 + i}`,
      priority: 'Low',
      labels: [],
      commentCount: 0,
    }),
  ),
]

/** The board holds more bugs than one hunt reads: the line that says the list is partial. */
export const Truncated: Story = {
  decorators: [opened()],
  parameters: {
    api: [
      boardsAnswer(),
      huntAnswer('jira', result({ candidates: firstForty, scanned: 40, truncated: true })),
    ],
  },
  play: async () => {
    await pickBoard('Auth (AUTH)')
    await hunt()
    await screen.findByText(/AUTH-142/)
  },
}
