import type { Meta, StoryObj } from '@storybook/vue3'
import type { ExecutionInstance } from '@cat-factory/contracts'
import { getRunSpecContract } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiResponse, artifactBlobPending, artifactBlobResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { referencePng, screenshotPng } from '~/stories/artifact.stories.mocks'
import { boardBlocks } from '~/stories/board.stories.mocks'
import {
  failedRun,
  OUTCOME_RUN_ID,
  outcomeTask,
  passedRun,
  runSpec,
  SESSIONS_SHOT,
  SIGN_IN_SHOT,
} from '~/stories/outcome.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedDocumentSources, seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import { documentConnections, documentSources } from '~/stories/integrations.stories.mocks'
import type { Block } from '~/types/domain'
import OutcomeSummaryWindow from './OutcomeSummaryWindow.vue'

// What a run changed and what backs it up, for a reader who does not read diffs: where the work
// stands and the pull request, what was asked, the pages the agents read and how current they
// were, which requirements the tester checked, how it tested, what the result looks like, the
// environment to try it in, and the machine checks. The card reduces the run it is opened on, so
// each story seeds the task and its run; it reads the spec the run was judged against, and the
// screenshots, which the stories answer. Each story seeds its own run, because the snapshot
// keeps a run a seed in the meta put there. The run is made up (`outcome.stories.mocks.ts`).
function opened(task: Block, run: ExecutionInstance | null) {
  return withSeed(() => {
    seedSnapshot(
      snapshot({
        blocks: boardBlocks.map((b) => (b.id === task.id ? task : b)),
        executions: run ? [run] : [],
      }),
    )
    seedDocumentSources(documentSources, documentConnections)
    seedResultView({
      view: 'outcome',
      blockId: task.id,
      instanceId: run?.id ?? null,
      stepIndex: null,
    })
  })
}

const specRead = apiResponse(getRunSpecContract, {
  pathPrefix: storyWorkspacePrefix,
  pathParams: { executionId: OUTCOME_RUN_ID },
  body: runSpec,
})

function answers(...own: HttpHandler[]): HttpHandler[] {
  return [
    ...own,
    specRead,
    artifactBlobResponse(screenshotPng, { artifactId: SIGN_IN_SHOT }),
    artifactBlobResponse(referencePng, { artifactId: SESSIONS_SHOT }),
  ]
}

const meta = {
  title: 'Run telemetry/Pages/OutcomeSummaryWindow',
  component: OutcomeSummaryWindow,
  parameters: { api: answers() },
} satisfies Meta<typeof OutcomeSummaryWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A run waiting for its pull request to merge: two of three requirements met and one new one not
 * exercised, the tester's green light with one low concern, two screenshots, the live preview,
 * and CI and validation passed.
 */
export const Default: Story = {
  decorators: [opened(outcomeTask(), passedRun)],
}

/** The card opened on a task the board no longer holds: nothing to summarise. */
export const Empty: Story = {
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot())
      seedResultView({ view: 'outcome', blockId: 'task_gone', instanceId: null, stepIndex: null })
    }),
  ],
}

/**
 * The task names a run the store does not hold (it left the store, or the read failed): each
 * section says the run could not be read, and the pull request is still one click away. A task
 * that has not run at all has no card: every entry point offers it only when there is something
 * to show.
 */
export const RunUnavailable: Story = {
  decorators: [opened(outcomeTask(), null)],
}

/**
 * The run failed: log out everywhere does not work, which the spec says it already did, so the
 * card counts a regression; three concerns, and CI red.
 */
export const NeedsAttention: Story = {
  decorators: [opened(outcomeTask({ status: 'blocked', pullRequest: undefined }), failedRun)],
}

/** The screenshots have not loaded yet: a placeholder for each. */
export const VisualsLoading: Story = {
  decorators: [opened(outcomeTask(), passedRun)],
  parameters: {
    api: answers(artifactBlobPending(SIGN_IN_SHOT), artifactBlobPending(SESSIONS_SHOT)),
  },
}
