import { listScheduleRunsContract } from '@cat-factory/contracts'
import type { Pipeline, PipelineSchedule, ScheduleRun } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks, logoutTask } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { usePipelinesStore } from '~/stores/pipelines'
import { useRecurringPipelinesStore } from '~/stores/recurringPipelines'
import RecurringScheduleSettings from './RecurringScheduleSettings.vue'

// The schedule behind a recurring task: its cadence, the next run, pause or resume, run now, and
// the recent runs, which the panel loads itself. An on-demand schedule has no cadence, only "Run
// now". A task with no schedule renders nothing, so there is no story for it.
const depUpdates: Pipeline = {
  id: 'pl_dep_update',
  name: 'Dependency updates',
  purpose: 'maintenance',
  agentKinds: ['coder', 'pr-reviewer'],
}

const weekly: PipelineSchedule = {
  id: 'sched_deps',
  serviceId: 'service_auth',
  blockId: logoutTask.id,
  frameId: authService.id,
  pipelineId: depUpdates.id,
  template: 'dep-update',
  name: 'Weekly dependency updates',
  recurrence: {
    intervalHours: 168,
    weekdays: [1],
    windowStartHour: 6,
    windowEndHour: 9,
    timezone: 'Europe/Madrid',
  },
  onDemand: false,
  enabled: true,
  lastRunAt: Date.UTC(2026, 8, 28, 6, 0, 0),
  nextRunAt: Date.UTC(2026, 9, 5, 6, 0, 0),
  createdAt: Date.UTC(2026, 8, 1),
}

function run(id: string, status: ScheduleRun['status'], day: number, outcome: string | null) {
  return {
    id,
    scheduleId: weekly.id,
    executionId: status === 'skipped' ? null : `exec_${id}`,
    status,
    startedAt: Date.UTC(2026, 8, day, 6, 0, 0),
    finishedAt: status === 'running' ? null : Date.UTC(2026, 8, day, 6, 40, 0),
    outcome,
  }
}

const runsAre = (runs: ScheduleRun[]) =>
  apiResponse(listScheduleRunsContract, {
    pathPrefix: storyWorkspacePrefix,
    pathParams: { scheduleId: weekly.id },
    body: runs,
  })

const withSchedule = (schedule: PipelineSchedule) =>
  withSeed(() => {
    seedBoard(boardBlocks)
    seedWorkspace()
    usePipelinesStore().hydrate([depUpdates])
    useRecurringPipelinesStore().hydrate([schedule])
  })

const meta = {
  title: 'Inspector/Components/RecurringScheduleSettings',
  component: RecurringScheduleSettings,
  args: { block: logoutTask },
  decorators: [withSchedule(weekly)],
  parameters: {
    width: 'panel',
    api: [
      runsAre([
        run('r3', 'done', 28, 'Opened #128 with 4 updates.'),
        run('r2', 'skipped', 21, 'Nothing to update.'),
        run('r1', 'failed', 14, 'Install failed on a peer conflict.'),
      ]),
    ],
  },
} satisfies Meta<typeof RecurringScheduleSettings>
export default meta

type Story = StoryObj<typeof meta>

/** Weekly on Mondays in a morning window, with three past runs. */
export const Default: Story = {}

/** Paused: the action offers to resume. */
export const Paused: Story = {
  decorators: [withSchedule({ ...weekly, enabled: false })],
}

/** On demand: no cadence, only "Run now". */
export const OnDemand: Story = {
  decorators: [withSchedule({ ...weekly, onDemand: true })],
  parameters: { api: [runsAre([])] },
}
