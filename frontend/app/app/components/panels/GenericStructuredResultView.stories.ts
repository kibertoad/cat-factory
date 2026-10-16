import type { Meta, StoryObj } from '@storybook/vue3'
import type { CustomAgentKind, ExecutionInstance } from '@cat-factory/contracts'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import GenericStructuredResultView from './GenericStructuredResultView.vue'

// The window for a deployment's own agent kind that returns structured JSON and has no window of
// its own: the agent's prose summary, then the JSON, pretty-printed, with a copy button. From the
// lg width a sidebar also gives the step's run facts; the captures are narrower. The kind, its
// summary and its JSON are made up: a dependency audit registered as `dependency-audit`.
const auditKind: CustomAgentKind = {
  kind: 'dependency-audit',
  container: true,
  executor: 'container',
  presentation: {
    label: 'Dependency audit',
    icon: 'i-lucide-package-search',
    color: '#0891b2',
    description: 'Lists outdated and vulnerable dependencies in the service.',
    category: 'review',
    resultView: 'generic-structured',
  },
}

const summary =
  'Two of 41 direct dependencies need attention. `jsonwebtoken` has a known advisory; ' +
  '`ioredis` is one major behind.'

const findings = {
  checked: 41,
  outdated: [{ name: 'ioredis', current: '4.28.5', latest: '5.4.1', major: true }],
  vulnerable: [{ name: 'jsonwebtoken', version: '8.5.1', severity: 'high' }],
}

function opened(output: string | undefined, custom: unknown) {
  return withSeed(() => {
    const run: ExecutionInstance = execution({
      steps: [step({ agentKind: 'dependency-audit', state: 'done', progress: 1, output, custom })],
      currentStep: 0,
      status: 'done',
    })
    seedSnapshot(snapshot({ executions: [run], customAgentKinds: [auditKind] }))
    seedResultView({
      view: 'generic-structured',
      blockId: run.blockId,
      instanceId: run.id,
      stepIndex: 0,
    })
  })
}

const meta = {
  title: 'Pipeline/Components/GenericStructuredResultView',
  component: GenericStructuredResultView,
  decorators: [opened(summary, findings)],
} satisfies Meta<typeof GenericStructuredResultView>
export default meta

type Story = StoryObj<typeof meta>

/** The summary, then the JSON with its copy button. */
export const Default: Story = {}

/** The agent returned prose only. */
export const ProseOnly: Story = { decorators: [opened(summary, undefined)] }

/** Neither: the empty state. */
export const Empty: Story = { decorators: [opened(undefined, undefined)] }
