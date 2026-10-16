import type { Meta, StoryObj } from '@storybook/vue3'
import type { WorkspaceSettings } from '@cat-factory/contracts'
import {
  adaptiveBuild,
  bugfixPipeline,
  bugFishingPipeline,
  documentPipeline,
  standardBuild,
} from '~/stories/pipelines.stories.mocks'
import { seedMember, seedWorkspace, withSeed } from '~/stories/withStores'
import { usePipelinesStore } from '~/stores/pipelines'
import { useTaskTypesStore } from '~/stores/taskTypes'
import { useUiStore } from '~/stores/ui'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'
import WorkspaceSettingsPanel from './WorkspaceSettingsPanel.vue'

// The Workspace settings window: the board's own configuration, in tabs. It opens on Workspace,
// the run and board settings this window edits itself: when a waiting task escalates, the running
// task limit, the input gate, review friction, what is recorded and kept, the run credential, the
// pipeline a bug-fishing fix runs and the Kaizen agent. The other tabs are their sections' own
// stories (`BudgetSettings`, `UsageSettings`, `RiskPolicyPanel`, `IssueTrackerPanel`,
// `ServiceFragmentDefaultsPanel`, `TaskTypeSuppressionsPanel`, `WorkspaceMetadataSettings`,
// `WorkspaceMembersSettings`). The Workspace tab reads the board's settings and pipelines from
// the snapshot, so each story seeds them and nothing loads. With no access seeded every
// permission holds, as on a deployment with sign-in off, so the Members tab shows. The Metadata
// tab does not show: no first-party module declares a custom board field, and Storybook does not
// run a deployment's module (`WorkspaceMetadataSettings` has the story that fills the slot).

/** The window opened on the Workspace tab, with the board's settings `overrides` on the defaults. */
function opened(overrides: Partial<WorkspaceSettings> = {}) {
  return withSeed(() => {
    seedWorkspace()
    const settings = useWorkspaceSettingsStore()
    settings.settings = { ...settings.settings, ...overrides }
    usePipelinesStore().hydrate([
      standardBuild,
      adaptiveBuild,
      bugfixPipeline,
      documentPipeline,
      bugFishingPipeline,
    ])
    useUiStore().openWorkspaceSettings()
  })
}

const meta = {
  title: 'Settings/Pages/WorkspaceSettingsPanel',
  component: WorkspaceSettingsPanel,
  decorators: [opened()],
} satisfies Meta<typeof WorkspaceSettingsPanel>
export default meta

type Story = StoryObj<typeof meta>

/** The board's defaults: seven tabs, no running task limit, and review friction off. */
export const Default: Story = {}

/**
 * A running task limit per task type, under each service: four features, two bugs, one document
 * and one spike at a time.
 */
export const PerTypeLimits: Story = {
  decorators: [
    opened({
      taskLimitMode: 'per_type',
      taskLimitPerType: { feature: 4, bug: 2, document: 1, spike: 1 },
    }),
  ],
}

/**
 * Review friction enforced: a confirm step from three tasks in review, and no new task from
 * eight.
 */
export const ReviewFrictionEnforce: Story = {
  decorators: [
    opened({
      reviewFrictionMode: 'enforce',
      reviewFrictionWarnCount: 3,
      reviewFrictionBlockCount: 8,
      reviewFrictionBlockStuckMinutes: null,
    }),
  ],
}

/** A deployment that also registers reusable operations: the Operations tab, eight tabs in all. */
export const AllTabs: Story = {
  decorators: [
    withSeed(() => {
      useTaskTypesStore().suppressedTaskTypes = ['acme:translation-sync']
    }),
  ],
}

/** A member of the board, who may not manage its roster: no Members tab. */
export const Member: Story = {
  decorators: [withSeed(seedMember)],
}
