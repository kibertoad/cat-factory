import type { Meta, StoryObj } from '@storybook/vue3'
import { resolveDocumentRefContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiFailure, apiPending, apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import {
  confluenceDescriptor,
  documentConnections,
  figmaDescriptor,
  resolvedDocumentRefWithDroppedScope,
  resolvedFigmaFrameRef,
  zeplinDescriptor,
} from '~/stories/integrations.stories.mocks'
import { seedBoard, seedDocumentSources, seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import StartFromDesignModal from './StartFromDesignModal.vue'

// Start a task on a service from a design link. The person pastes a Figma or Zeplin link, the
// connected design sources check it in turn, and Continue opens the add-task form with the design
// attached. The row says when the link was trimmed, and when a frame link was widened to the whole
// file. The check runs on Enter or when the field loses focus, so the stories type the link and
// press Enter. The refusal is the backend's (`refUnresolved` in `DocumentImportService`); the
// links are made up.
const FRAME_SHARE_LINK =
  'https://www.figma.com/design/Xq3hT9mPa2Lk/Sign-in?node-id=1204-88&t=Qm8xZ1'
const INSTANCE_LINK =
  'https://www.figma.com/design/Xq3hT9mPa2Lk/Sign-in?node-id=I2649:14930;2649:14746&t=Qm8xZ1'

const figma = { pathPrefix: storyWorkspacePrefix, pathParams: { source: 'figma' as const } }

/** The form on Auth Service, with `designSources` connected beside Confluence. */
function opened(designSources = [figmaDescriptor]) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    seedDocumentSources(
      [confluenceDescriptor, ...designSources],
      [
        documentConnections[0]!,
        ...designSources.map((d) => ({
          source: d.source,
          label: d.label,
          connectedAt: Date.UTC(2026, 8, 22),
        })),
      ],
    )
    useUiStore().openStartFromDesign(authService.id)
  })
}

async function paste(link: string) {
  await userEvent.type(await screen.findByTestId('start-from-design-link'), `${link}{enter}`)
}

const meta = {
  title: 'Documents/Components/StartFromDesignModal',
  component: StartFromDesignModal,
} satisfies Meta<typeof StartFromDesignModal>
export default meta

type Story = StoryObj<typeof meta>

/** Figma is connected: the link field, and Continue waits for a link. */
export const Default: Story = {
  decorators: [opened()],
}

/** No design source is connected, so there is no field, only the line that says so. */
export const NoSource: Story = {
  decorators: [opened([])],
}

/** Figma has not answered yet. */
export const Checking: Story = {
  decorators: [opened()],
  parameters: { api: [apiPending(resolveDocumentRefContract, figma)] },
  play: () => paste(FRAME_SHARE_LINK),
}

/** A frame share link: the frame's URL, and a line that says the link was trimmed. */
export const Resolved: Story = {
  decorators: [opened()],
  parameters: {
    api: [apiResponse(resolveDocumentRefContract, { ...figma, body: resolvedFigmaFrameRef })],
  },
  play: async () => {
    await paste(FRAME_SHARE_LINK)
    await screen.findByTestId('start-from-design-resolved')
  },
}

/**
 * A component instance link, whose node id Figma's parser cannot read: the whole file is
 * attached, and the amber line names the frame that was dropped.
 */
export const ResolvedWidened: Story = {
  decorators: [opened()],
  parameters: {
    api: [
      apiResponse(resolveDocumentRefContract, {
        ...figma,
        body: resolvedDocumentRefWithDroppedScope,
      }),
    ],
  },
  play: async () => {
    await paste(INSTANCE_LINK)
    await screen.findByTestId('start-from-design-resolved')
  },
}

/** A link Figma cannot read: the refusal line, and Continue stays off. */
export const Rejected: Story = {
  decorators: [opened()],
  parameters: {
    api: [
      apiRefusal(resolveDocumentRefContract, {
        ...figma,
        status: 422,
        error: {
          code: 'validation',
          message: `Could not resolve a figma page id from 'https://acme.dev/sign-in'. Expected ${figmaDescriptor.refPlaceholder}`,
          details: {
            reason: 'document_ref_unrecognized',
            source: 'figma',
            expected: figmaDescriptor.refPlaceholder,
          },
        },
      }),
    ],
  },
  play: async () => {
    await paste('https://acme.dev/sign-in')
    await screen.findByTestId('start-from-design-rejected')
  },
}

/**
 * The check itself failed. With Figma the only design source, the link is attached as pasted
 * and the import judges it.
 */
export const Unchecked: Story = {
  decorators: [opened()],
  parameters: { api: [apiFailure(resolveDocumentRefContract, figma)] },
  play: async () => {
    await paste(FRAME_SHARE_LINK)
    await screen.findByTestId('start-from-design-resolved')
  },
}

/**
 * The check failed with Figma and Zeplin both connected: nothing can say which one the link is
 * for, so Continue stays off and the line asks to try again.
 */
export const UncheckedAmbiguous: Story = {
  decorators: [opened([figmaDescriptor, zeplinDescriptor])],
  parameters: { api: [apiFailure(resolveDocumentRefContract, figma)] },
  play: async () => {
    await paste(FRAME_SHARE_LINK)
    await screen.findByTestId('start-from-design-resolved')
  },
}
