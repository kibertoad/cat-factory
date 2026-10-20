import type { Meta, StoryObj } from '@storybook/vue3'
import type { DocumentBoardPlan, DocumentSourceKind } from '@cat-factory/contracts'
import { planDocumentContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { sourceDocument, sourceDocuments } from '~/stories/integrations.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import SpawnPreviewModal from './SpawnPreviewModal.vue'

// What an imported document would add to the board, before anything is written: the frames, the
// modules and the tasks, and whether a model or the heading parser planned them. A prose document
// plans new services at the board root. A design document cannot answer that, so it is planned
// into a service that already exists, and the modal asks for that service before it asks for a
// plan. It plans when it opens, so each story answers that request. Spawning sends a request no
// story answers. The plans are made up; the heading plan follows the backend's parser
// (`planFromHeadings` in integrations: h1 a service, h2 a module, h3 a task).
const lifecycle = sourceDocument()
const figmaFrame = sourceDocuments.find((d) => d.source === 'figma')!

function planned(source: DocumentSourceKind, body: DocumentBoardPlan) {
  return apiResponse(planDocumentContract, {
    pathPrefix: storyWorkspacePrefix,
    pathParams: { source },
    body,
  })
}

/** The model's plan for the session lifecycle page: two services at the board root. */
const llmPlan: DocumentBoardPlan = {
  source: 'confluence',
  externalId: lifecycle.externalId,
  planner: 'llm',
  targetFrameId: null,
  frames: [
    {
      type: 'service',
      title: 'Session Service',
      modules: [
        {
          name: 'Refresh tokens',
          tasks: [{ title: 'Rotate refresh tokens on use' }, { title: 'Revoke a token family' }],
        },
        { name: 'Sign-out', tasks: [{ title: 'Log out everywhere' }] },
      ],
      tasks: [{ title: 'Issue a session on sign-in' }],
    },
    {
      type: 'database',
      title: 'Session Store',
      modules: [],
      tasks: [{ title: 'Add the token families table' }],
    },
  ],
}

/**
 * The heading parser's plan for the same page, whose outline is one h1 ("Session lifecycle"),
 * two h2s and three h3s.
 */
const headingsPlan: DocumentBoardPlan = {
  source: 'confluence',
  externalId: lifecycle.externalId,
  planner: 'headings',
  targetFrameId: null,
  frames: [
    {
      type: 'service',
      title: 'Session lifecycle',
      modules: [
        { name: 'Issuing', tasks: [{ title: 'Sign-in' }, { title: 'Refresh' }] },
        { name: 'Revoking', tasks: [{ title: 'Sign-out' }] },
      ],
      tasks: [],
    },
  ],
}

/** The model's plan for the sign-in frame, into the Auth Service: one frame standing for it. */
const designPlan: DocumentBoardPlan = {
  source: 'figma',
  externalId: figmaFrame.externalId,
  planner: 'llm',
  targetFrameId: authService.id,
  frames: [
    {
      type: 'service',
      title: authService.title,
      modules: [
        {
          name: 'Sign-in screen',
          tasks: [
            { title: 'Show the locked-account state' },
            { title: 'Ask for the second factor' },
          ],
        },
      ],
      tasks: [{ title: 'Return field errors the screen can place' }],
    },
  ],
}

function opened(source: DocumentSourceKind, externalId: string) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    useUiStore().openSpawnPreview(source, externalId)
  })
}

const meta = {
  title: 'Documents/Components/SpawnPreviewModal',
  component: SpawnPreviewModal,
  decorators: [opened('confluence', lifecycle.externalId)],
  parameters: { api: [planned('confluence', llmPlan)] },
} satisfies Meta<typeof SpawnPreviewModal>
export default meta

type Story = StoryObj<typeof meta>

/** A model's plan: two new top-level frames, with their modules and tasks. */
export const Default: Story = {}

/** No model configured, so the heading parser planned it: one service from the page's outline. */
export const HeadingsPlanner: Story = { parameters: { api: [planned('confluence', headingsPlan)] } }

/** The plan is being built: a spinner, and Spawn is disabled. */
export const Loading: Story = {
  parameters: {
    api: [
      apiPending(planDocumentContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { source: 'confluence' },
      }),
    ],
  },
}

/** A Figma frame: the service picker, and a line that a service is needed before a plan. */
export const DesignNeedsTarget: Story = {
  decorators: [opened('figma', figmaFrame.externalId)],
}

/** The Auth Service picked: the plan of what goes inside it. */
export const DesignIntoService: Story = {
  decorators: [opened('figma', figmaFrame.externalId)],
  parameters: { api: [planned('figma', designPlan)] },
  play: async () => {
    await userEvent.click(await screen.findByTestId('spawn-target-frame'))
    await userEvent.click(await screen.findByRole('option', { name: authService.title }))
    await screen.findByText('Show the locked-account state')
  },
}
