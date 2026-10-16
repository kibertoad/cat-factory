import type { Meta, StoryObj } from '@storybook/vue3'
import { onBeforeUnmount } from 'vue'
import { fn, userEvent, within } from 'storybook/test'
import { artifactBlobResponse } from '~/stories/api'
import { referencePng, screenshotPng } from '~/stories/artifact.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useArtifactBlobs, type ArtifactBlobs } from '~/composables/useArtifactBlobs'
import ImageCompare from './ImageCompare.vue'

// A screenshot of what a run built beside the reference it should match. With both images there
// are four modes: side by side, overlay with an opacity slider, swipe with a handle, and a pixel
// diff drawn on a canvas. Without a reference, side by side shows an upload control. The render
// loads both images through the real artifact loader, and the stories answer each artifact's
// bytes: the reference is the screenshot with its card 8px lower.
const meta = {
  title: 'Review/Components/ImageCompare',
  component: ImageCompare,
  parameters: {
    width: 'prose',
    api: [
      artifactBlobResponse(screenshotPng, { artifactId: 'art_actual' }),
      artifactBlobResponse(referencePng, { artifactId: 'art_reference' }),
    ],
  },
  decorators: [withSeed(seedWorkspace)],
  args: {
    view: 'Sign in',
    // A placeholder: the render passes the real loader, which needs the story's Nuxt app.
    blobs: {} as ArtifactBlobs,
    actualId: 'art_actual',
    referenceId: 'art_reference',
    onExpand: fn(),
    onUploadReference: fn(),
  },
  render: (args) => ({
    components: { ImageCompare },
    setup() {
      const blobs = useArtifactBlobs()
      void blobs.resolve(args.actualId)
      void blobs.resolve(args.referenceId)
      onBeforeUnmount(blobs.revokeAll)
      return { args, blobs }
    },
    template: '<ImageCompare v-bind="args" :blobs="blobs" />',
  }),
} satisfies Meta<typeof ImageCompare>
export default meta

type Story = StoryObj<typeof meta>

const pickMode =
  (name: RegExp) =>
  async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name }))
  }

/** Both images loaded: side by side, with the four mode buttons. */
export const Default: Story = {}

/** No reference: side by side only, with the upload control. */
export const NoReference: Story = { args: { referenceId: null } }

/** Overlay, with the opacity slider. */
export const Overlay: Story = { play: pickMode(/overlay/i) }

/** Swipe, with the split handle. */
export const Swipe: Story = { play: pickMode(/swipe/i) }

/** The pixel diff: what moved shows bright on black. */
export const Diff: Story = { play: pickMode(/diff/i) }

/** A reference rendered from a linked design: the caption says so. */
export const DesignReference: Story = { args: { referenceOrigin: 'design' } }
