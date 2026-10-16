import type { Meta, StoryObj } from '@storybook/vue3'
import { onBeforeUnmount } from 'vue'
import { fn, screen } from 'storybook/test'
import { artifactBlobFailure, artifactBlobPending, artifactBlobResponse } from '~/stories/api'
import { referencePng, screenshotPng } from '~/stories/artifact.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useArtifactBlobs, type ArtifactBlobs } from '~/composables/useArtifactBlobs'
import ArtifactLightbox from './ArtifactLightbox.vue'

// A full-screen viewer for a run's images, with zoom, pan and arrows between them. It loads the
// current image and its two neighbours through the artifact loader it is given, so a story
// answers each artifact's bytes. A counter and the arrows show only for more than one image.
const items = [
  { artifactId: 'art_signin', label: 'Sign in', alt: 'The sign in page' },
  { artifactId: 'art_signin_ref', label: 'Sign in (reference)', alt: 'The sign in design' },
  { artifactId: 'art_reset', label: 'Password reset', alt: 'The password reset page' },
]

// The bytes for every image but the first. A story's `api` replaces the meta's, so a story that
// changes the first image spreads these after its own handler.
const neighbours = [
  artifactBlobResponse(referencePng, { artifactId: 'art_signin_ref' }),
  artifactBlobResponse(screenshotPng),
]

const meta = {
  title: 'Primitives/Components/ArtifactLightbox',
  component: ArtifactLightbox,
  parameters: { api: neighbours },
  decorators: [withSeed(seedWorkspace)],
  args: {
    open: true,
    // A placeholder: the render passes the real loader, which needs the story's Nuxt app.
    blobs: {} as ArtifactBlobs,
    index: 0,
    items,
    'onUpdate:open': fn(),
    'onUpdate:index': fn(),
  },
  render: (args) => ({
    components: { ArtifactLightbox },
    setup() {
      const blobs = useArtifactBlobs()
      onBeforeUnmount(blobs.revokeAll)
      return { args, blobs }
    },
    template: '<ArtifactLightbox v-bind="args" :blobs="blobs" />',
  }),
} satisfies Meta<typeof ArtifactLightbox>
export default meta

type Story = StoryObj<typeof meta>

/** The first of three images, with the counter and the arrows. */
export const Default: Story = {}

/** One image: no counter, no arrows. */
export const Single: Story = { args: { items: items.slice(0, 1) } }

/** The image has not arrived: the loading line. */
export const Loading: Story = {
  parameters: { api: [artifactBlobPending('art_signin'), ...neighbours] },
  play: async () => {
    await screen.findByText('Loading…')
  },
}

/** The image failed to load: the failure line and Retry. */
export const Failed: Story = {
  parameters: { api: [artifactBlobFailure('art_signin'), ...neighbours] },
  play: async () => {
    await screen.findByText('Failed to load image.')
  },
}
