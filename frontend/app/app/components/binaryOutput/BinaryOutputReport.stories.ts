import type { Meta, StoryObj } from '@storybook/vue3'
import type {
  BinaryCandidateStepState,
  BinaryOutputArtifact,
  BinaryOutputConfig,
  BinaryOutputReport as Report,
} from '@cat-factory/contracts'
import { artifactBlobResponse } from '~/stories/api'
import { referencePng } from '~/stories/artifact.stories.mocks'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import type { PipelineStep } from '~/types/execution'
import BinaryOutputReport from './BinaryOutputReport.vue'

// What a media step delivered: the outcome in one sentence, where the step was told to store its
// assets, then each asset with where it went and what made it, and every way the record falls
// short, each on its own line. An asset in the platform's own storage shows itself. The report
// reads only the step, so each story passes one; the preview's bytes are the shared reference
// screenshot. `card` is the step reader's framed section; `flat` is the result window footer's.
//
// The storage service and Nano Banana are real (`platform-asset-service.ts` in kernel and the
// `binary-generators` package); `acme-media` and the assets are made up.
const config: BinaryOutputConfig = {
  storageServiceId: 'platform-assets',
  generatorIds: ['nano-banana'],
  modalities: ['image'],
}

const hero: BinaryOutputArtifact = {
  service: 'platform-assets',
  location: 'art_login_hero',
  entity: 'Login hero image',
  contentType: 'image/png',
  description: 'A calm illustration for the sign-in page, in the brand palette.',
  dimensions: { width: 1024, height: 1024 },
  generator: 'nano-banana',
  modality: 'image',
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    stored: [hero],
    unknownServices: [],
    unknownGenerators: [],
    invalidEntries: 0,
    omitted: 0,
    ...overrides,
  }
}

function mediaStep(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return step({
    agentKind: 'media-generator',
    state: 'done',
    progress: 1,
    stepOptions: { binaryOutput: config },
    binaryOutputs: report(),
    ...overrides,
  })
}

const meta = {
  title: 'Pipeline/Components/BinaryOutputReport',
  component: BinaryOutputReport,
  args: { step: mediaStep(), variant: 'card' },
  parameters: {
    width: 'prose',
    api: [artifactBlobResponse(referencePng, { artifactId: 'art_login_hero' })],
  },
  decorators: [withSeed(seedWorkspace)],
} satisfies Meta<typeof BinaryOutputReport>
export default meta

type Story = StoryObj<typeof meta>

/** One image in the platform's storage: the preview, its size, type and generator. */
export const Default: Story = {}

/** The step has not started: only where its assets will go. */
export const NotStarted: Story = {
  args: { step: mediaStep({ state: 'pending', progress: 0, binaryOutputs: undefined }) },
}

/** The step is running, or stopped before it recorded anything. */
export const Configured: Story = {
  args: { step: mediaStep({ state: 'working', progress: 0.5, binaryOutputs: undefined }) },
}

/** The step finished and its reply declared nothing. */
export const Undeclared: Story = {
  args: { step: mediaStep({ binaryOutputs: report({ stored: [], undeclared: true }) }) },
}

/** The declaration was there and could not be read. */
export const ParseFailed: Story = {
  args: { step: mediaStep({ binaryOutputs: report({ stored: [], parseFailed: true }) }) },
}

/** The step said it stored nothing, which is a legitimate outcome. */
export const DeclaredNone: Story = {
  args: { step: mediaStep({ binaryOutputs: report({ stored: [] }) }) },
}

/**
 * Everything that can qualify a delivery. The step asked for a 1024×1024 PNG and a WebP. One
 * asset went to `acme-media` instead of the selected storage, which the catalog does not know,
 * and names an integration the deployment does not register. The hero came back at the wrong
 * size, a second image reports none, no WebP arrived, one entry was malformed and two were cut.
 */
export const WithWarnings: Story = {
  args: {
    step: mediaStep({
      stepOptions: {
        binaryOutput: {
          ...config,
          mediaTypes: ['image/png', 'image/webp'],
          generation: { outputSize: { width: 1024, height: 1024 } },
        },
      },
      binaryOutputs: report({
        stored: [
          { ...hero, dimensions: { width: 1536, height: 1024 } },
          {
            service: 'acme-media',
            location: 's3://acme-media/login/hero-dark.png',
            entity: 'Login hero image, dark',
            contentType: 'image/png',
            generator: 'acme-diffusion',
            processedBy: 'imagemagick',
            modality: 'image',
          },
        ],
        unknownServices: ['acme-media'],
        unknownGenerators: ['acme-diffusion'],
        invalidEntries: 1,
        omitted: 2,
      }),
    }),
  },
}

const candidates: BinaryCandidateStepState = {
  status: 'chosen',
  candidates: [1, 2, 3, 4].map((n) => ({
    id: `cand_${n}`,
    label: `Option ${n}`,
    generator: 'nano-banana',
    service: 'platform-assets',
    location: `art_login_hero_${n}`,
    contentType: 'image/png',
  })),
  choice: {
    kept: [{ candidateId: 'cand_2' }],
    discarded: ['cand_1', 'cand_3', 'cand_4'],
    at: Date.UTC(2026, 9, 11, 11),
  },
  invalidEntries: 0,
  omitted: 0,
  unusablePreviews: 0,
}

/** The step compared four candidates and a person kept one: that line comes first. */
export const WithCandidates: Story = { args: { step: mediaStep({ binaryCandidates: candidates }) } }

/** The result window footer's version: no heading and no frame. */
export const Flat: Story = { args: { variant: 'flat' } }
