import type { Meta, StoryObj } from '@storybook/vue3'
import { artifactBlobFailure, artifactBlobPending, artifactBlobResponse } from '~/stories/api'
import { referencePng } from '~/stories/artifact.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import StoredAssetView from './StoredAssetView.vue'

// An asset a step stored through the platform's own storage, so the platform holds the bytes:
// the picture itself, or a named file when it is not one, and links to open it full size or save
// it. Whether it renders as a picture follows the type the server serves, not the type the agent
// declared. The bytes load through the artifact blob route, which each story answers; the image
// is the shared reference screenshot, and the 3D model's bytes are made up.
const meta = {
  title: 'Pipeline/Components/StoredAssetView',
  component: StoredAssetView,
  args: { assetId: 'art_login_hero', contentType: 'image/png', label: 'Login hero image' },
  parameters: {
    width: 'panel',
    api: [artifactBlobResponse(referencePng, { artifactId: 'art_login_hero' })],
  },
  decorators: [withSeed(seedWorkspace)],
} satisfies Meta<typeof StoredAssetView>
export default meta

type Story = StoryObj<typeof meta>

/** A PNG: the preview, then Open and Download. */
export const Default: Story = {}

/** A binary glTF model: served as a file, so the row names its declared type. */
export const File: Story = {
  args: { assetId: 'art_badge_model', contentType: 'model/gltf-binary', label: 'Badge model' },
  parameters: {
    api: [
      artifactBlobResponse(Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]), {
        artifactId: 'art_badge_model',
        contentType: 'model/gltf-binary',
      }),
    ],
  },
}

/** The bytes in flight: a placeholder block. */
export const Loading: Story = { parameters: { api: [artifactBlobPending('art_login_hero')] } }

/** The bytes could not load: a line and Retry. */
export const Error: Story = { parameters: { api: [artifactBlobFailure('art_login_hero')] } }
