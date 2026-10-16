import type { Meta, StoryObj } from '@storybook/vue3'
import { listDocumentsContract, resolveDocumentRefContract } from '@cat-factory/contracts'
import { ref } from 'vue'
import { fn, screen, userEvent } from 'storybook/test'
import type { PendingContext } from '~/composables/useContextLinking'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import {
  confluenceDescriptor,
  documentConnections,
  documentSources,
  figmaDescriptor,
  jiraDescriptor,
  resolvedFigmaFrameRef,
  sourceDocument,
  sourceDocuments,
  sourceTask,
  taskSources,
} from '~/stories/integrations.stories.mocks'
import { seedBoard, seedDocumentSources, seedWorkspace, withSeed } from '~/stories/withStores'
import { useTasksStore } from '~/stores/tasks'
import ContextAttachmentFields from './ContextAttachmentFields.vue'

// The context half of the add-task form (and of the initiative form): documents and tracker
// issues to attach to a task that does not exist yet. The picks are only staged; the form links
// them once the task is created. Each half's Attach opens an inline picker, or becomes a way to
// connect a source when none is connected. A link pasted into the description is offered as an
// attachment when a connected source recognises it. The hints are the add-task form's. The
// sources are the shared ones: Confluence, Figma and GitHub Docs, and GitHub Issues and Jira.
const pathPrefix = storyWorkspacePrefix
const issue = sourceTask()

const sessionLifecycle: PendingContext = {
  kind: 'document',
  source: 'confluence',
  externalId: '48213377',
  title: 'Session lifecycle',
  subtitle: confluenceDescriptor.label,
  icon: confluenceDescriptor.icon,
  needsImport: false,
}

/** A frame picked by link that is not imported yet, so it imports when the task is added. */
const signInFrame: PendingContext = {
  kind: 'document',
  source: 'figma',
  externalId: resolvedFigmaFrameRef.externalId,
  title: 'Sign in, all states',
  subtitle: resolvedFigmaFrameRef.canonicalUrl ?? figmaDescriptor.label,
  icon: figmaDescriptor.icon,
  needsImport: true,
}

const linkedIssue: PendingContext = {
  kind: 'task',
  source: 'jira',
  externalId: issue.externalId,
  title: `${issue.externalId} · ${issue.title}`,
  subtitle: issue.status,
  icon: jiraDescriptor.icon,
  needsImport: false,
}

/** The shared sources, connected as the shell's probes find them; `false` connects nothing. */
function sources(connected = true) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    seedDocumentSources(documentSources, connected ? documentConnections : [])
    const tasks = useTasksStore()
    tasks.available = true
    tasks.sources = connected ? taskSources : taskSources.map((s) => ({ ...s, available: false }))
  })
}

const meta = {
  title: 'Board/Components/ContextAttachmentFields',
  component: ContextAttachmentFields,
  parameters: { width: 'prose' },
  args: {
    modelValue: [],
    docsHint: 'Attach a requirement, RFC or PRD so agents see it while implementing this task.',
    issuesHint:
      'Attach a tracker issue so agents see its description and comments while implementing this task.',
    scopeBlockId: authService.id,
    'onUpdate:modelValue': fn(),
  },
  // The host owns the staged list; the render holds it, so a pick or a removal shows.
  render: (args) => ({
    components: { ContextAttachmentFields },
    setup() {
      const staged = ref<PendingContext[]>(args.modelValue)
      return { args, staged }
    },
    template: '<ContextAttachmentFields v-bind="args" v-model="staged" />',
  }),
  decorators: [sources()],
} satisfies Meta<typeof ContextAttachmentFields>
export default meta

type Story = StoryObj<typeof meta>

/** A Confluence page and a Jira issue attached, and a Figma frame that imports when the task is added. */
export const Default: Story = {
  args: { modelValue: [sessionLifecycle, signInFrame, linkedIssue] },
}

/** Nothing attached: each half shows its hint. */
export const Empty: Story = {}

/** No source connected: each half offers to connect one of the sources the deployment has. */
export const NotConnected: Story = {
  decorators: [sources(false)],
}

const FRAME_SHARE_LINK =
  'https://www.figma.com/design/Xq3hT9mPa2Lk/Sign-in?node-id=1204-88&t=Qm8xZ1'

/** A description that links a Figma frame: Figma recognises it, so the form offers to attach it. */
export const PastedLinkOffer: Story = {
  args: {
    description: `Match the locked and two-factor states in ${FRAME_SHARE_LINK}.`,
  },
  parameters: {
    api: [
      apiResponse(resolveDocumentRefContract, {
        pathPrefix,
        pathParams: { source: 'figma' },
        body: resolvedFigmaFrameRef,
      }),
    ],
  },
  play: async () => {
    await screen.findByTestId('pasted-link-offer')
  },
}

/** The document picker opened from Attach, over the imported documents. */
export const DocumentPickerOpen: Story = {
  parameters: {
    api: [
      apiResponse(listDocumentsContract, {
        pathPrefix,
        body: [
          ...sourceDocuments,
          sourceDocument({ externalId: '48213390', title: 'Token store' }),
        ],
      }),
    ],
  },
  play: async () => {
    const [attachDocument] = await screen.findAllByRole('button', { name: 'Attach' })
    await userEvent.click(attachDocument!)
    await screen.findByText('Token store')
  },
}
