import type { Meta, StoryObj } from '@storybook/vue3'
import type { VisualConfirmPair, VisualConfirmStepState } from '@cat-factory/contracts'
import { artifactBlobResponse } from '~/stories/api'
import { referencePng, screenshotPng } from '~/stories/artifact.stories.mocks'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import VisualConfirmationWindow from './VisualConfirmationWindow.vue'

// A person compares the UI tester's screenshots of the login task with the reference designs,
// view by view, and approves, asks for a fix (a note per view and one for the whole), or asks for
// new screenshots. Each pair says where its reference came from: a linked design, or an upload.
// A reference can be uploaded for any view. Without screenshots the window says so, and Approve
// waits for "I reviewed this another way". The state rides on the run's visual-confirmation
// step, so each story seeds its own run; the images are answered from the shared screenshot
// fixtures. The degraded reason is the backend's own wording (`VisualConfirmationController`);
// the views and the findings are made up.
const SHOT = 'art_vc_shot'
const REFERENCE = 'art_vc_reference'

const signIn: VisualConfirmPair = {
  view: 'Sign in',
  actualArtifactId: SHOT,
  referenceArtifactId: REFERENCE,
  referenceOrigin: 'design',
}
const sessions: VisualConfirmPair = {
  view: 'Active sessions',
  actualArtifactId: SHOT,
  referenceArtifactId: REFERENCE,
  referenceOrigin: 'upload',
}
const accountMenu: VisualConfirmPair = { view: 'Account menu', actualArtifactId: SHOT }

const NO_SCREENSHOTS =
  'No UI screenshots were captured for this task — review the change manually, then approve or ' +
  'request a fix.'

function gate(overrides: Partial<VisualConfirmStepState> = {}): VisualConfirmStepState {
  return {
    phase: 'awaiting_human',
    pairs: [signIn, sessions, accountMenu],
    designReferences: { documents: 1, images: 1 },
    attempts: 0,
    maxAttempts: 3,
    rounds: [],
    ...overrides,
  }
}

function opened(state: VisualConfirmStepState | null) {
  const run = execution({
    steps: [
      step({ agentKind: 'coder', state: 'done', progress: 1 }),
      step({ agentKind: 'tester-ui', state: 'done', progress: 1 }),
      step({
        agentKind: 'visual-confirmation',
        state: state?.phase === 'approved' ? 'done' : 'working',
        progress: state?.phase === 'approved' ? 1 : 0.5,
        ...(state ? { visualConfirm: state } : {}),
      }),
    ],
    currentStep: 2,
  })
  return withSeed(() => {
    seedSnapshot(snapshot({ executions: [run] }))
    seedResultView({
      view: 'visual-confirm',
      blockId: run.blockId,
      instanceId: run.id,
      stepIndex: 2,
    })
  })
}

const meta = {
  title: 'Review/Components/VisualConfirmationWindow',
  component: VisualConfirmationWindow,
  parameters: {
    api: [
      artifactBlobResponse(screenshotPng, { artifactId: SHOT }),
      artifactBlobResponse(referencePng, { artifactId: REFERENCE }),
    ],
  },
} satisfies Meta<typeof VisualConfirmationWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Three views: Sign in against the linked design's frame, Active sessions against an uploaded
 * mock, and the account menu with no reference. A note per view, the fix box, and Approve.
 */
export const Default: Story = {
  decorators: [opened(gate())],
}

/** The step has not started its gate yet. */
export const NotStarted: Story = {
  decorators: [opened(null)],
}

const findings =
  '### Sign in\nThe error text sits under the button, not under the field.\n\n' +
  '### General\nThe spacing between the fields is tighter than in the design.'

/** A fix is in flight: the fixer works on the notes, and the round is open. */
export const Fixing: Story = {
  decorators: [
    opened(
      gate({
        phase: 'fixing',
        attempts: 1,
        rounds: [
          {
            findings,
            helperKind: 'fixer',
            jobId: 'job_vc_1',
            outcome: null,
            at: Date.UTC(2026, 9, 13, 10, 40),
          },
        ],
      }),
    ),
  ],
}

/** Approved after one fix: the record of the round, and nothing left to do. */
export const Approved: Story = {
  decorators: [
    opened(
      gate({
        phase: 'approved',
        attempts: 1,
        rounds: [
          {
            findings,
            helperKind: 'fixer',
            jobId: 'job_vc_1',
            outcome: 'completed',
            at: Date.UTC(2026, 9, 13, 11, 0),
          },
        ],
      }),
    ),
  ],
}

/**
 * Nothing was captured, and the design gave its frames: the backend's reason, the reference-only
 * pairs, and Approve waits for "I reviewed this another way".
 */
export const Degraded: Story = {
  decorators: [
    opened(
      gate({
        pairs: [{ ...signIn, actualArtifactId: null }],
        degradedReason: NO_SCREENSHOTS,
      }),
    ),
  ],
}

/**
 * Two linked designs that gave less than their whole set: the source kept only part of one's
 * frames, and the gallery's ceiling left out three frames of the other.
 */
export const DesignGaps: Story = {
  decorators: [
    opened(
      gate({
        designReferences: {
          documents: 2,
          images: 1,
          dropped: 3,
          gaps: [
            { title: 'Sign in, all states', reason: 'partial' },
            { title: 'Account settings', reason: null, dropped: 3 },
          ],
        },
      }),
    ),
  ],
}

/** No screenshot and no reference at all: the empty gallery, and the reason. */
export const NoPairs: Story = {
  decorators: [opened(gate({ pairs: [], designReferences: null, degradedReason: NO_SCREENSHOTS }))],
}
