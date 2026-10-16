import type { Meta, StoryObj } from '@storybook/vue3'
import {
  getObservabilityConnectionContract,
  listAgentPromptsContract,
  listReleaseHealthConfigsContract,
  listWorkspaceAgentSettingsContract,
} from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import type { Pipeline } from '~/types/domain'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { consensusGroups } from '~/stories/consensus.stories.mocks'
import { foundationalApi } from '~/stories/foundationalApi'
import {
  adaptiveBuild,
  bugfixPipeline,
  documentPipeline,
  reviewPipeline,
  standardBuild,
} from '~/stories/pipelines.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useConsensusGroupsStore } from '~/stores/consensusGroups'
import { usePipelinesStore } from '~/stores/pipelines'
import { useUiStore } from '~/stores/ui'
import PipelineBuilder from './PipelineBuilder.vue'

// The pipeline builder, a panel from the left: the agent catalog to pick steps from, the draft
// with each step's options, and the board's saved pipelines. Each step can have a companion that
// reviews it, a run condition, an approval gate, and options of its kind (a consensus panel for a
// design step, the follow-ups of a coder, the coverage audit of a tester). The library lists the
// pipelines of the draft's purpose, with labels to filter by, and hides the archived ones behind a
// count. When it opens, the builder reads the observability connection, the prompt overrides, the
// agent settings and the foundational services; the stories answer each read with nothing set.
// The custom pipelines are made up. Every button sends a request no story answers.

const hotfix: Pipeline = {
  id: 'pl_hotfix',
  name: 'Hotfix',
  purpose: 'build',
  description: 'Implement, review and merge a small fix, with a person on the merge.',
  version: 2,
  builtin: false,
  labels: ['fast', 'ops'],
  agentKinds: ['coder', 'reviewer', 'ci', 'merger'],
  gates: [false, false, false, true],
}

const legacyRelease: Pipeline = {
  id: 'pl_legacy_release',
  name: 'Legacy release train',
  purpose: 'build',
  description: 'The release flow from before the board had testers.',
  version: 1,
  builtin: false,
  archived: true,
  labels: ['ops'],
  agentKinds: ['architect', 'coder', 'ci', 'merger'],
}

const library: Pipeline[] = [
  standardBuild,
  adaptiveBuild,
  bugfixPipeline,
  hotfix,
  legacyRelease,
  documentPipeline,
  reviewPipeline,
]

/** The reads the builder makes when it opens, each answered with nothing configured. */
const openReads = [
  apiResponse(getObservabilityConnectionContract, {
    pathPrefix: storyWorkspacePrefix,
    body: { connected: false, provider: null, summary: null },
  }),
  apiResponse(listReleaseHealthConfigsContract, { pathPrefix: storyWorkspacePrefix, body: [] }),
  apiResponse(listAgentPromptsContract, { pathPrefix: storyWorkspacePrefix, body: [] }),
  apiResponse(listWorkspaceAgentSettingsContract, { pathPrefix: storyWorkspacePrefix, body: [] }),
  ...foundationalApi('workspace'),
]

/** The builder opened over `pipelines`, with `draft` building the draft. */
function builder(draft: () => void = () => {}, pipelines: Pipeline[] = library) {
  return withSeed(() => {
    seedSnapshot(snapshot({ pipelines }))
    const store = usePipelinesStore()
    store.clearDraft()
    useConsensusGroupsStore().hydrate(consensusGroups)
    draft()
    useUiStore().builderOpen = true
  })
}

/**
 * A new build pipeline: the estimator first, the architect with its companion gated on the
 * estimate, the coder with the reviewer as its companion, and the merger with a person on it.
 */
function buildDraft() {
  const store = usePipelinesStore()
  store.draftName = 'Login hardening'
  for (const kind of ['task-estimator', 'architect', 'coder', 'reviewer', 'merger'] as const) {
    store.addToDraft(kind)
  }
  store.toggleCompanion(1)
  store.toggleDraftGating(2)
  store.toggleDraftGate(store.draft.length - 1)
}

const meta = {
  title: 'Pipeline/Pages/PipelineBuilder',
  component: PipelineBuilder,
  parameters: { layout: 'fullscreen', api: openReads },
} satisfies Meta<typeof PipelineBuilder>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A new draft of four steps and two companions, with the architect's companion gated on the
 * estimate, and the library of build pipelines, with one archived behind its count.
 */
export const Default: Story = { decorators: [builder(buildDraft)] }

/** A board with no saved pipeline and an empty draft: no library column. */
export const Empty: Story = { decorators: [builder(() => {}, [])] }

/** Hotfix loaded for editing: its name, labels and steps, and Update in place of Save. */
export const EditingSaved: Story = {
  decorators: [builder(() => usePipelinesStore().loadForEdit(hotfix))],
}

/**
 * A review pipeline with a coder in it, and a companion gated on an estimate nothing makes: both
 * warnings above the steps, and Save is off.
 */
export const DraftWarnings: Story = {
  decorators: [
    builder(() => {
      const store = usePipelinesStore()
      store.draftPurpose = 'review'
      store.addToDraft('architect')
      store.addToDraft('coder')
      store.toggleCompanion(0)
      store.toggleDraftGating(1)
    }),
  ],
}

/**
 * The architect runs as a consensus: the board's two groups to escalate to, then the inline
 * panel with its strategy and participants.
 */
export const ConsensusStep: Story = {
  decorators: [
    builder(() => {
      const store = usePipelinesStore()
      store.addToDraft('architect')
      store.addToDraft('coder')
      store.toggleDraftConsensus(0)
    }),
  ],
}

/** The archived pipeline shown in the library, faded. */
export const ArchivedShown: Story = {
  decorators: [builder(buildDraft)],
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }))
  },
}

/** Add agent opens its form: a name, a description and Link doc. */
export const AddAgentOpen: Story = {
  decorators: [builder(buildDraft)],
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Add agent' }))
  },
}
