import type { Meta, StoryObj } from '@storybook/vue3'
import { MAX_TASK_IMAGES } from '@cat-factory/contracts'
import { referencePng, screenshotPng } from '~/stories/artifact.stories.mocks'
import TaskImageField from './TaskImageField.vue'

// The images attached to a task: a thumbnail per image with a remove control, then the picker and
// the count against the per-task ceiling. Shared by the add-task form and the inspector, which own
// the files; this draws them.

const pngUrl = (bytes: Uint8Array<ArrayBuffer>) =>
  URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))

const two = [
  { key: 'a', name: 'crash-on-save.png', url: pngUrl(screenshotPng) },
  { key: 'b', name: 'expected-layout.png', url: pngUrl(referencePng) },
]

const meta = {
  title: 'Board/Components/TaskImageField',
  component: TaskImageField,
  args: { images: two },
  parameters: { width: 'panel' },
} satisfies Meta<typeof TaskImageField>
export default meta

type Story = StoryObj<typeof meta>

/** Two images attached, room for more. */
export const Default: Story = {}

/** Nothing attached yet: the picker and a zero count. */
export const Empty: Story = { args: { images: [] } }

/** An upload in flight: the picker and the remove controls wait for it. */
export const Loading: Story = { args: { busy: true } }

/** A thumbnail whose bytes have not arrived draws a placeholder in its place. */
export const ThumbnailPending: Story = {
  args: { images: [{ key: 'a', name: 'crash-on-save.png' }] },
}

/** At the ceiling: the picker is disabled and the count says why. */
export const Full: Story = {
  args: {
    images: Array.from({ length: MAX_TASK_IMAGES }, (_, i) => ({
      key: String(i),
      name: `image-${i}.png`,
      url: pngUrl(screenshotPng),
    })),
  },
}

/** A viewer, who cannot write the board: thumbnails only. */
export const ReadOnly: Story = { args: { disabled: true } }
