import type { Meta, StoryObj } from '@storybook/vue3'
import {
  getDocInterviewContract,
  type DocInterviewQa,
  type DocInterviewSession,
} from '@cat-factory/contracts'
import type { ExecutionInstance } from '~/types/domain'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { block } from '~/stories/block.stories.mocks'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { documentPipeline } from '~/stories/pipelines.stories.mocks'
import { failure, step } from '~/stories/pipelineStep.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import DocInterviewWindow from './DocInterviewWindow.vue'

// The document interview: between the outline and the draft, the interviewer asks about scope,
// audience and structure, and a person answers in this window. Submit answers sends them and the
// interviewer runs again; Draft now skips the rest. While the run does something else, the window
// says what instead of the questions. The window opens as the interviewer step's result view and
// reads the session again when it opens, so each story answers that read with its own session.
// The session is not in the snapshot; only the read brings it. The task is a document task under
// Auth Service, on the document pipeline. Every button sends a request no story answers.

const docsTask = block({
  id: 'task_session_docs',
  title: 'Document the session lifecycle',
  parentId: 'svc_auth',
  taskType: 'document',
  status: 'in_progress',
})

const RUN = 'exec_session_docs'
const INTERVIEWER = documentPipeline.agentKinds.indexOf('doc-interviewer')
const created = Date.UTC(2026, 9, 14, 9, 0)

/** The questions of round one: two answered, two open. */
const questions: DocInterviewQa[] = [
  {
    id: 'q_audience',
    question: 'Who reads this first: the service owners or the on-call engineers?',
    answer: 'On-call engineers. They need to know what to check when sign-ins fail.',
  },
  {
    id: 'q_scope',
    question: 'Does the document cover the legacy cookie, or only the new session store?',
    answer: 'Only the new store. The legacy cookie gets one paragraph that links to its own page.',
  },
  {
    id: 'q_diagrams',
    question: 'Do you want a sequence diagram for the token refresh?',
    answer: '',
  },
  {
    id: 'q_examples',
    question: 'Which examples matter most: a normal refresh, a reused token, or a revoked session?',
    answer: '',
  },
]

const brief = `Audience: on-call engineers who look into failed sign-ins.

Scope: the new session store, from sign-in to log out everywhere. The legacy cookie gets one paragraph and a link.

Structure:
1. The lifecycle of a session, with a sequence diagram of the token refresh.
2. What a reused refresh token does, and how to see it in the audit log.
3. What to check when sign-ins fail, in order.`

function session(overrides: Partial<DocInterviewSession> = {}): DocInterviewSession {
  return {
    id: 'dis_session_docs',
    blockId: docsTask.id,
    status: 'awaiting',
    round: 1,
    maxRounds: 3,
    qa: questions,
    brief: null,
    model: 'workers-ai:@cf/zai-org/glm-5.2',
    createdAt: created,
    updatedAt: created + 12 * 60_000,
    ...overrides,
  }
}

/** The document run, at `currentStep`, with each step before it done. */
function docRun(
  status: ExecutionInstance['status'],
  currentStep: number,
  overrides: Partial<ExecutionInstance> = {},
): ExecutionInstance {
  return {
    id: RUN,
    blockId: docsTask.id,
    pipelineId: documentPipeline.id,
    pipelineName: documentPipeline.name,
    steps: documentPipeline.agentKinds.map((agentKind, i) =>
      step({
        agentKind,
        state: i < currentStep ? 'done' : i === currentStep ? 'working' : 'pending',
        progress: i < currentStep ? 1 : i === currentStep ? 0.5 : 0,
      }),
    ),
    currentStep,
    status,
    ...overrides,
  }
}

/** The window opened on the interviewer step of `run`, whose session read answers `entity`. */
function opened(run: ExecutionInstance, entity: DocInterviewSession | null): Story {
  return {
    decorators: [
      withSeed(() => {
        seedSnapshot(
          snapshot({
            blocks: [...boardBlocks, { ...docsTask, executionId: run.id }],
            executions: [run],
          }),
        )
        seedResultView({
          view: 'doc-interview',
          blockId: docsTask.id,
          instanceId: run.id,
          stepIndex: INTERVIEWER,
        })
      }),
    ],
    parameters: {
      api: [
        apiResponse(getDocInterviewContract, {
          pathPrefix: storyWorkspacePrefix,
          pathParams: { blockId: docsTask.id },
          body: entity,
        }),
      ],
    },
  }
}

const meta = {
  title: 'Documents/Pages/DocInterviewWindow',
  component: DocInterviewWindow,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DocInterviewWindow>
export default meta

type Story = StoryObj<typeof meta>

/** The run waits on round one: two questions answered, two open, so Submit answers is off. */
export const Default: Story = opened(docRun('blocked', INTERVIEWER), session())

/** The read finds no session for the task: the empty state. */
export const Empty: Story = opened(docRun('blocked', INTERVIEWER), null)

/**
 * The run still outlines the document, ahead of the interview. The session holds the questions of
 * an earlier run, which the window does not show.
 */
export const Preparing: Story = opened(
  docRun('running', documentPipeline.agentKinds.indexOf('doc-outliner')),
  session(),
)

/** The interviewer reads the answers and writes its next round: the notice replaces the list. */
export const Working: Story = opened(docRun('running', INTERVIEWER), session())

/** The run failed before the interview settled: the failed notice, and no actions. */
export const Failed: Story = opened(
  docRun('failed', INTERVIEWER, {
    failure: failure({
      message: 'The interviewer returned no questions and no brief.',
      stepIndex: INTERVIEWER,
    }),
  }),
  session(),
)

/** The interview settled and the writer drafts: the authoring brief. */
export const Converged: Story = opened(
  docRun('running', documentPipeline.agentKinds.indexOf('doc-writer')),
  session({
    status: 'done',
    round: 2,
    qa: questions.map((q) => ({ ...q, answer: q.answer || 'Yes.' })),
    brief,
  }),
)

/** The run waits, but the session holds no question: the line that nothing is pending. */
export const NoQuestions: Story = opened(
  docRun('blocked', INTERVIEWER),
  session({ round: 0, qa: [] }),
)
