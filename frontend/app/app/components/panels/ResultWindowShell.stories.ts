import type { Meta, StoryObj } from '@storybook/vue3'
import type { ExecutionInstance } from '@cat-factory/contracts'
import { getExecutionContract } from '@cat-factory/contracts'
import { apiFailure, apiPending } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { effortReport } from '~/stories/stepReports.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import ResultWindowShell from './ResultWindowShell.vue'

// The frame every result window shares: a header with an icon, a title and close, the window's
// own body, and the footer sections the engine records on the step (the effort rating, the
// pre-PR validation and the reproduction proof). The footer reads the open window's step, so a
// story that shows it opens a result view on a seeded run. The body here is a placeholder
// paragraph; each window's own stories show a real one. `stretch` fills the height and `centered`
// fits the content; the width is a bucket from 3xl to the whole viewport. Only the effort rating
// is shown: the validation and the reproduction proof are the coder step's, and a coder step
// opens a window only when it is parked (a fork decision, follow-ups or binary candidates). The
// binary outputs are not shown either.
const meta = {
  title: 'Primitives/Components/ResultWindowShell',
  component: ResultWindowShell,
  args: {
    open: true,
    icon: 'i-lucide-clipboard-check',
    iconClass: 'bg-primary/15 text-primary',
    title: 'PR review',
    subtitle: 'Login endpoint',
  },
  render: (args) => ({
    components: { ResultWindowShell },
    setup: () => ({ args }),
    template: `
      <ResultWindowShell v-bind="args">
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm text-toned">
          <p class="max-w-3xl">
            The window's own content goes here: a verdict, a report, or a review. The shell gives
            it the space between the header and the footer sections.
          </p>
        </div>
      </ResultWindowShell>`,
  }),
} satisfies Meta<typeof ResultWindowShell>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Open the PR review window on the pr-reviewer step (index 2) of the login run in `run`. The app
 * opens a window from the step's agent kind, and the pr-reviewer is the build pipeline's step
 * with a window of its own; the coder step has none.
 */
function onStep(run: ExecutionInstance) {
  return withSeed(() => {
    seedSnapshot(snapshot({ executions: [run] }))
    seedResultView({ view: 'pr-review', blockId: run.blockId, instanceId: run.id, stepIndex: 2 })
  })
}

/** The default: 3xl wide and the full height, with no step behind it. */
export const Default: Story = {}

/** Centered: as tall as the content, up to 90% of the screen. */
export const Centered: Story = { args: { variant: 'centered' } }

/** The whole viewport less the gutter, for a window that lays out in columns. */
export const FullWidth: Story = { args: { width: 'full' } }

/** Opened on a step: Restart from here sits before close. */
export const WithRestart: Story = {
  args: { stepRef: { instanceId: 'exec_login', stepIndex: 2 } },
  decorators: [onStep(execution())],
}

/** The finished review step's effort rating, collapsed to one line. */
export const WithStepReports: Story = {
  decorators: [
    onStep(
      execution({
        steps: [
          step({ agentKind: 'architect', state: 'done', progress: 1 }),
          step({ agentKind: 'coder', state: 'done', progress: 1 }),
          step({
            agentKind: 'pr-reviewer',
            state: 'done',
            progress: 1,
            effortReport,
          }),
        ],
        currentStep: 2,
        status: 'done',
      }),
    ),
  ],
}

/**
 * The board holds only the projected run, so the shell asks for the whole run: a line says it is
 * loading.
 */
export const RunLoading: Story = {
  decorators: [onStep(execution({ projected: true }))],
  parameters: {
    api: [
      apiPending(getExecutionContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { executionId: 'exec_login' },
      }),
    ],
  },
}

/** The whole-run read failed: the line says so with the reason. */
export const RunLoadFailed: Story = {
  decorators: [onStep(execution({ projected: true }))],
  parameters: {
    api: [
      apiFailure(getExecutionContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { executionId: 'exec_login' },
      }),
    ],
  },
}
