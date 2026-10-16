import type { Meta, StoryObj } from '@storybook/vue3'
import type {
  BinaryOutputConfig,
  RegisteredBinaryGenerator,
  ResolvedFoundationalService,
} from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { withSeed } from '~/stories/withStores'
import { useAgentsStore } from '~/stores/agents'
import { useFoundationalServicesStore } from '~/stores/foundationalServices'
import { usePipelinesStore } from '~/stores/pipelines'
import BinaryOutputStepPicker from './BinaryOutputStepPicker.vue'

// What a media step in the pipeline builder stores its assets in, which services shape what it
// makes, and which integrations make it: storage first, and the rest once storage is set. Under
// them, the content types and formats the step must deliver, the generation controls the
// selected integrations declare, and the candidate comparison. Each problem with the selection
// is a line of its own. The storage list is the service catalog's `asset-storage` entries; the
// integrations come from the snapshot.
//
// The pipelines store's `setDraftBinaryOutput` keeps only the storage, context, integrations and
// content types, and drops `mediaTypes`, `generation` and `comparison`. Every control below the
// content types writes through it, so none of them is kept: the GenerationControls and
// Comparison stories seed those options and the picker shows them empty, which is what the app
// does after a click or an edit.
//
// The platform storage and Nano Banana are copies of the shipped ones (`platform-asset-service.ts`
// in kernel, `nano-banana.ts` in `binary-generators`), with their contracts left out. The brand
// service and the sprite renderer, which declares an exact size, are made up.
const platformAssets: ResolvedFoundationalService = {
  id: 'platform-assets',
  name: 'Platform asset storage',
  summary: 'Stores generated assets in this deployment’s own content storage.',
  description: 'The storage this platform runs for itself, offered as an asset store.',
  capabilities: ['asset-storage'],
  contracts: [],
  tier: 'builtin',
}
const brandGuide: ResolvedFoundationalService = {
  id: 'brand-guide',
  name: 'Brand guide',
  summary: 'Acme’s colours, type and illustration rules.',
  description: 'The brand rules every generated asset must follow.',
  capabilities: ['generation-context'],
  contracts: [],
  tier: 'workspace',
}

const nanoBanana: RegisteredBinaryGenerator = {
  id: 'nano-banana',
  name: 'Nano Banana',
  summary: 'Google’s Gemini image models.',
  modalities: ['image'],
  mediaTypes: ['image/png', 'image/jpeg'],
  capabilities: ['reference-image', 'multi-reference', 'instruction-edit', 'seed', 'aspect-ratio'],
  accepts: {
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  },
}
const spriteRenderer: RegisteredBinaryGenerator = {
  id: 'sprite-renderer',
  name: 'Sprite renderer',
  summary: 'Renders game sprites at an exact size.',
  modalities: ['image'],
  mediaTypes: ['image/png'],
  capabilities: ['exact-size', 'seed', 'transparent-background', 'tileable', 'candidate-batch'],
}

function picking(
  config: BinaryOutputConfig | undefined,
  options: { catalogAvailable?: boolean; generatorsUnavailable?: boolean } = {},
) {
  return withSeed(() => {
    const catalog = useFoundationalServicesStore()
    catalog.available = options.catalogAvailable ?? true
    catalog.resolved = options.catalogAvailable === false ? [] : [platformAssets, brandGuide]
    useAgentsStore().hydrateBinaryGenerators(
      options.generatorsUnavailable ? [] : [nanoBanana, spriteRenderer],
      options.generatorsUnavailable ?? false,
    )
    usePipelinesStore().setDraftBinaryOutput(0, config)
  })
}

const selected: BinaryOutputConfig = {
  storageServiceId: 'platform-assets',
  contextServiceIds: ['brand-guide'],
  generatorIds: ['nano-banana'],
  modalities: ['image'],
}

const meta = {
  title: 'Pipeline/Components/BinaryOutputStepPicker',
  component: BinaryOutputStepPicker,
  args: { index: 0 },
  parameters: { width: 'prose' },
  decorators: [picking(selected)],
} satisfies Meta<typeof BinaryOutputStepPicker>
export default meta

type Story = StoryObj<typeof meta>

/** Platform storage, the brand guide, Nano Banana and images: its controls and formats. */
export const Default: Story = {}

/** Nothing picked: only the storage select. */
export const Empty: Story = { decorators: [picking(undefined)] }

/**
 * The sprite renderer offers an exact size, a seed, transparency and tiling. The seeded 96×96 and
 * transparent background do not show, because the store dropped them (see above).
 */
export const GenerationControls: Story = {
  decorators: [
    picking({
      ...selected,
      generatorIds: ['sprite-renderer'],
      generation: { outputSize: { width: 96, height: 96 }, transparentBackground: true },
    }),
  ],
}

/**
 * Three candidates per integration, more than one kept: seeded, and dropped by the store, so the
 * comparison box shows unticked and its two controls do not show.
 */
export const Comparison: Story = {
  decorators: [picking({ ...selected, comparison: { perGenerator: 3, multiSelect: true } })],
}

/** The service catalog could not be read: no storage to offer, and a line that says so. */
export const CatalogUnavailable: Story = {
  decorators: [picking(undefined, { catalogAvailable: false })],
}

/** The integrations could not be read: the select is empty, and a line that says so. */
export const GeneratorsUnavailable: Story = {
  decorators: [picking({ ...selected, generatorIds: [] }, { generatorsUnavailable: true })],
}

/** The step must deliver a 3D model, and Nano Banana makes images only. */
export const ModalityUncovered: Story = {
  decorators: [picking({ ...selected, modalities: ['image', '3d-model'] })],
}

/** A width with no height, committed on blur: nothing is stored yet, and a line says why. */
export const OutputSizeIncomplete: Story = {
  decorators: [picking({ ...selected, generatorIds: ['sprite-renderer'] })],
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByTestId('binary-output-size-width'), '96')
    await userEvent.tab()
    await within(canvasElement).findByTestId('binary-output-size-incomplete')
  },
}
