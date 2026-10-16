import type { Meta, StoryObj } from '@storybook/vue3'
import type { Pipeline, RetiredPipelineWire } from '@cat-factory/contracts'
import {
  adaptiveBuild,
  bugfixPipeline,
  reproTestKind,
  standardBuild,
} from '~/stories/pipelines.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import PipelineHealthModal from './PipelineHealthModal.vue'

// The advisory the board opens once per session when its pipelines need attention: new built-ins
// to add, broken pipelines (an agent kind this build does not know, or a bad shape), built-ins
// older than the catalog, and built-ins the catalog withdrew. The finding happens in the SPA, from
// the pipelines and the catalog versions the snapshot carries, so each story seeds those and opens
// the modal. Removing a pipeline asks first.
//
// The catalog versions are the three shipped pipelines' own; `pl_frontend` is a real retired
// built-in, replaced by `pl_build` (`buildRetiredPipelines` in kernel). The bugfix pipeline's
// `repro-test` kind is registered, so the snapshot carries it. The custom pipeline with an
// unknown kind is made up.
const current = {
  [standardBuild.id]: standardBuild.version,
  [adaptiveBuild.id]: adaptiveBuild.version,
  [bugfixPipeline.id]: bugfixPipeline.version,
}
const names = {
  [standardBuild.id]: standardBuild.name,
  [adaptiveBuild.id]: adaptiveBuild.name,
  [bugfixPipeline.id]: bugfixPipeline.name,
}

const staleAdaptive: Pipeline = { ...adaptiveBuild, version: 6 }
const frontendPipeline: Pipeline = {
  id: 'pl_frontend',
  name: 'Frontend',
  purpose: 'build',
  builtin: true,
  version: 2,
  agentKinds: ['coder', 'tester-ui', 'merger'],
}
const customWithUnknownKind: Pipeline = {
  id: 'pl_custom_audit',
  name: 'Release audit',
  purpose: 'review',
  agentKinds: ['dependency-audit'],
}

function opened(
  pipelines: Pipeline[],
  retired: RetiredPipelineWire[] = [],
  versions: Record<string, number> = current,
) {
  return withSeed(() => {
    seedSnapshot(
      snapshot({
        pipelines,
        pipelineCatalogVersions: versions,
        pipelineCatalogNames: names,
        retiredPipelines: retired,
        customAgentKinds: [reproTestKind],
      }),
    )
    useUiStore().openPipelineHealth()
  })
}

const meta = {
  title: 'Pipeline/Components/PipelineHealthModal',
  component: PipelineHealthModal,
  decorators: [opened([standardBuild, staleAdaptive, customWithUnknownKind])],
} satisfies Meta<typeof PipelineHealthModal>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Bug fix is new to this board, Release audit names a kind this build does not know, and Adaptive
 * build is two versions behind. Reseed all covers the two built-ins.
 */
export const Default: Story = {}

/** Every pipeline current: the all-valid line. */
export const Empty: Story = {
  decorators: [opened([standardBuild, adaptiveBuild, bugfixPipeline])],
}

/** Only Adaptive build is behind: one section. */
export const OnlyOutdated: Story = {
  decorators: [opened([standardBuild, staleAdaptive, bugfixPipeline])],
}

/** The board still holds the withdrawn Frontend pipeline: Remove, and what replaced it. */
export const RetiredOnly: Story = {
  decorators: [
    opened(
      [standardBuild, adaptiveBuild, bugfixPipeline, frontendPipeline],
      [{ id: 'pl_frontend', replacedBy: 'pl_build' }],
    ),
  ],
}
