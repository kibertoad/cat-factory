import type { Meta, StoryObj } from '@storybook/vue3'
import type { TesterStepState, TesterQualityStepState } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen, userEvent } from 'storybook/test'
import type { PipelineStep } from '~/types/execution'
import { artifactBlobFailure, artifactBlobResponse } from '~/stories/api'
import { referencePng, screenshotPng } from '~/stories/artifact.stories.mocks'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { testReport, testerState } from '~/stories/testing.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import TestReportWindow from './TestReportWindow.vue'

// The tester's report on the login task, over the whole screen: the scenarios it walked with the
// checks and concerns under each, the verdict and the counts beside them, and above them the
// infrastructure the tester ran on, the fixer's rounds and the coverage audit. The window reads
// everything off the run's tester step and asks for nothing when it opens, except the bytes of
// the screenshots. The report is the shared tester fixture; the rest is each story's own. Every
// button sends a request no story answers.

const at = Date.UTC(2026, 9, 14, 12, 0)

const container = {
  status: 'up' as const,
  phase: 'agent',
  id: 'job-7f3c9a2e',
  url: 'http://localhost:43117',
}

/** The login run with the tester as its third step, opened in the window. */
function opened(tester: Partial<PipelineStep>, runStatus: 'running' | 'failed' = 'running') {
  const run = execution({
    status: runStatus,
    currentStep: 2,
    steps: [
      step({ agentKind: 'architect', state: 'done', progress: 1 }),
      step({ agentKind: 'coder', state: 'done', progress: 1 }),
      step({ agentKind: 'tester-api', state: 'working', progress: 0.6, ...tester }),
    ],
  })
  return withSeed(() => {
    seedSnapshot(snapshot({ executions: [run] }))
    seedResultView({ view: 'tester', blockId: run.blockId, instanceId: run.id, stepIndex: 2 })
  })
}

function story(tester: Partial<PipelineStep>, api: HttpHandler[] = []): Story {
  return { decorators: [opened(tester)], parameters: { api } }
}

const shots = [
  { view: 'Log out everywhere', artifactId: 'art_logout_shot', width: 1280, height: 800 },
  { view: 'Account settings', artifactId: 'art_settings_shot', width: 1280, height: 800 },
]

const meta = {
  title: 'Pipeline/Pages/TestReportWindow',
  component: TestReportWindow,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof TestReportWindow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A greenlit report: every check passed, one low concern, a screenshot under its scenario and one
 * in the gallery below.
 */
export const Default: Story = story(
  {
    state: 'done',
    progress: 1,
    test: testerState({
      phase: 'testing',
      attempts: 0,
      lastReport: testReport({
        greenlight: true,
        summary: 'Sign-in, refresh and log out everywhere work on both browsers.',
        outcomes: [
          { name: 'Sign in and refresh', status: 'passed' },
          { name: 'Expired refresh token answers 401', status: 'passed' },
          { name: 'Log out everywhere', status: 'passed' },
        ],
        concerns: [{ title: 'Error copy names the token type', detail: '', severity: 'low' }],
        screenshots: shots,
      }),
    }),
  },
  [
    artifactBlobResponse(screenshotPng, { artifactId: 'art_logout_shot' }),
    artifactBlobResponse(referencePng, { artifactId: 'art_settings_shot' }),
  ],
)

/** The tester is at work and has no report yet. */
export const Empty: Story = story({
  test: testerState({ phase: 'testing', attempts: 0, lastReport: null }),
})

/**
 * The report withholds the greenlight: one check failed and a high concern blocks, so the
 * scenario turns red and the badge says it needs fixes.
 */
export const Failing: Story = story({ test: testerState({ phase: 'testing', attempts: 0 }) })

const fixing: TesterStepState = testerState({
  attempts: 2,
  attemptLog: [
    {
      attempt: 1,
      at,
      outcome: 'failed',
      summary: 'The fixer container was lost before it pushed.',
    },
    {
      attempt: 2,
      at: at + 12 * 60_000,
      outcome: 'completed',
      summary: 'Revoke the access tokens of the family with the refresh tokens.',
      concerns: [
        {
          title: 'Access tokens outlive a logout',
          detail: '',
          severity: 'high',
        },
      ],
    },
  ],
})

/** The fixer is on its second of three rounds: the count in the header and both rounds above. */
export const Fixing: Story = story({ test: fixing })

const quality: TesterQualityStepState = {
  enabled: true,
  attempts: 2,
  maxAttempts: 2,
  exceeded: true,
  verdicts: [
    {
      adequate: false,
      feedback: 'The report does not try a revoked token from the **second** browser.',
      gaps: ['A revoked access token from another device', 'Logging out twice'],
      at,
      model: 'claude-sonnet-5-5',
    },
    {
      adequate: false,
      feedback: 'The second browser is covered now. Logging out twice is still not.',
      gaps: ['Logging out twice'],
      at: at + 9 * 60_000,
      model: 'claude-sonnet-5-5',
    },
  ],
}

/**
 * The coverage audit ran twice and found gaps both times, so it used its reruns: newest first,
 * with the badge that says so.
 */
export const QualityAudit: Story = story({
  test: testerState({ phase: 'testing', attempts: 0 }),
  testerQuality: quality,
})

/**
 * The dependencies could not come up in the container, because Docker did not answer: the
 * stand-up card with its error and logs, over a failed run.
 */
export const InfraSetupFailed: Story = {
  decorators: [
    opened(
      {
        state: 'working',
        container,
        test: testerState({
          phase: 'testing',
          attempts: 0,
          lastReport: null,
          infraSetup: {
            started: false,
            dockerAvailable: false,
            composePath: 'deploy/docker-compose.test.yml',
            at,
            durationMs: 4200,
            error: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
            logs:
              '$ docker compose -f deploy/docker-compose.test.yml up -d --wait\n' +
              'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. ' +
              'Is the docker daemon running?',
          },
        }),
      },
      'failed',
    ),
  ],
  play: async () => {
    await userEvent.click(await screen.findByTestId('tester-infra-setup-logs-toggle'))
  },
}

/** The bytes of both screenshots could not be read: each tile says so in place of the image. */
export const ScreenshotLoadFailed: Story = story(
  {
    test: testerState({
      phase: 'testing',
      attempts: 0,
      lastReport: testReport({ screenshots: shots }),
    }),
  },
  [artifactBlobFailure('art_logout_shot'), artifactBlobFailure('art_settings_shot')],
)
