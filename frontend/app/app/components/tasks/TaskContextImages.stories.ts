import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import { screenshotPng } from '~/stories/artifact.stories.mocks'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { boardWithInitiative, loginTask } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { opensTo } from '~/stories/inspectorSection'
import TaskContextImages from './TaskContextImages.vue'

// The images attached to an existing task, in the inspector. The task's image listing has no
// route contract (the upload beside it is multipart), so it is answered raw, as are the bytes,
// which are read through the task too. The section starts closed, so each story opens it. An add
// or a remove sends requests no story answers.

const listing = `*${storyWorkspacePrefix}/blocks/${loginTask.id}/images`

const imageBytes = http.get(
  `${listing}/:artifactId/blob`,
  () => new HttpResponse(screenshotPng, { headers: { 'content-type': 'image/png' } }),
)

function artifact(id: string, kind: string, view: string) {
  return { id, kind, view, contentType: 'image/png', byteSize: 3, createdAt: 1 }
}

function artifactsAre(artifacts: ReturnType<typeof artifact>[]) {
  return http.get(listing, () => HttpResponse.json({ artifacts }))
}

const meta = {
  title: 'Inspector/Components/TaskContextImages',
  component: TaskContextImages,
  args: { block: loginTask },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedBoard(boardWithInitiative)
    }),
  ],
  parameters: {
    width: 'panel',
    api: [artifactsAre([artifact('art_1', 'context', 'crash-on-save.png')]), imageBytes],
  },
} satisfies Meta<typeof TaskContextImages>
export default meta

type Story = StoryObj<typeof meta>

/** One attached image, drawn from the bytes its task serves. */
export const Default: Story = { play: opensTo((c) => c.findByAltText('crash-on-save.png')) }

/** Nothing attached: the picker and a zero count. */
export const Empty: Story = {
  parameters: { api: [artifactsAre([])] },
  play: opensTo((c) => c.findByRole('button', { name: 'Add images' })),
}

/** The listing refused (no storage configured, say): the failure in place of the picker. */
export const Failed: Story = {
  parameters: {
    api: [
      http.get(listing, () =>
        HttpResponse.json(
          { error: { code: 'unavailable', message: 'Binary-artifact storage is not configured' } },
          { status: 503 },
        ),
      ),
    ],
  },
  play: opensTo((c) => c.findByText('Could not load the attached images')),
}
