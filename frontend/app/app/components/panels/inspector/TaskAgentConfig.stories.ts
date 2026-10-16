import type { Meta, StoryObj } from '@storybook/vue3'
import type { AgentConfigDescriptor, Pipeline } from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { boardWith, loginTask } from '~/stories/board.stories.mocks'
import { buildPipeline, execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { withSnapshot } from '~/stories/withStores'
import TaskAgentConfig from './TaskAgentConfig.vue'

// The task options that the agents in the task's pipeline contribute, such as the coder's
// implementation-fork decision. Each option can change until its agent's step starts, then it
// locks for that run. An option already set on the task stays listed after the pipeline changes.
// The descriptors are copies of the backend's (`kinds/configs.ts` and `kinds/ralph.ts` in agents),
// which the snapshot carries as `agentConfigCatalog`. A click saves to the block, which no story
// answers. The section starts closed, so each story opens it.
const meta = {
  title: 'Inspector/Components/TaskAgentConfig',
  component: TaskAgentConfig,
  parameters: { width: 'panel' },
} satisfies Meta<typeof TaskAgentConfig>
export default meta

type Story = StoryObj<typeof meta>

/**
 * `InspectorSection` opens closed, so each play opens it first and then waits for what the story
 * shows.
 */
function opensTo(shown: (canvas: ReturnType<typeof within>) => Promise<unknown>) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await userEvent.click(await within(canvasElement).findByTestId('inspector-section-toggle'))
    await shown(within(canvasElement))
  }
}

const forkDecision: AgentConfigDescriptor = {
  id: 'coder.forkDecision',
  agentKind: 'coder',
  label: 'Implementation-fork decision',
  description:
    'Surface materially different implementation approaches before the Coder writes code and park for a human choice. `auto` gates on the task risk policy; `always` proposes regardless; `off` never proposes.',
  type: 'select',
  options: [
    { value: 'auto', label: 'Auto (gate on risk policy)' },
    { value: 'always', label: 'Always propose' },
    { value: 'off', label: 'Off' },
  ],
  default: 'auto',
}

const reproductionProof: AgentConfigDescriptor = {
  id: 'coder.reproductionProof',
  agentKind: 'coder',
  label: 'Reproduction proof',
  description:
    'Run the reproduction test the run declared against BOTH the pre-fix tree and the finished one, and publish the two results on the pull request: only failing-then-passing proves the fix. `auto` runs it whenever the pipeline produced a reproduction declaration; `always` pins that behaviour for this task; `off` never runs it. A failed proof never fails the run, it is reported as unproven.',
  type: 'select',
  options: [
    { value: 'auto', label: 'Auto (whenever the run declared a reproduction)' },
    { value: 'always', label: 'Always, when a reproduction is declared' },
    { value: 'off', label: 'Off' },
  ],
  default: 'auto',
}

const e2eTarget: AgentConfigDescriptor = {
  id: 'playwright.e2eTarget',
  agentKind: 'playwright',
  label: 'E2E execution target',
  description:
    'Where the acceptance / end-to-end tests run: in the project CI (GitHub Actions), or against the provisioned ephemeral environment.',
  type: 'select',
  options: [
    { value: 'ci', label: 'Project CI (GitHub Actions)' },
    { value: 'ephemeral', label: 'Ephemeral environment' },
  ],
  default: 'ci',
}

const validationCommand: AgentConfigDescriptor = {
  id: 'ralph.validationCommand',
  agentKind: 'ralph',
  label: 'Validation command',
  description:
    'The programmatic completion criterion. After each iteration the harness runs this shell command in the checkout; exit code 0 means the loop is done. Runs only inside the sandboxed run container. Example: pnpm test && pnpm typecheck',
  type: 'text',
  options: [],
  placeholder: 'pnpm test && pnpm typecheck',
  default: '',
}

const maxIterations: AgentConfigDescriptor = {
  id: 'ralph.maxIterations',
  agentKind: 'ralph',
  label: 'Max iterations',
  description:
    'The anti-runaway budget: the most times the loop re-runs before it hands off to a human. Each iteration is a fresh-context run.',
  type: 'number',
  options: [],
  placeholder: '10',
  default: '10',
}

/** The built-in Ralph loop pipeline (`seed.ts` in kernel). */
const ralphPipeline: Pipeline = {
  id: 'pl_ralph',
  name: 'Ralph loop',
  purpose: 'build',
  agentKinds: ['ralph', 'conflicts', 'ci', 'merger'],
}

const catalog = [forkDecision, reproductionProof, e2eTarget, validationCommand, maxIterations]

/** The login task on `pipelineId`, with `agentConfig` set on it. */
function task(pipelineId: string, agentConfig?: Record<string, string>) {
  return { ...loginTask, pipelineId, agentConfig }
}

function withTask(
  block: ReturnType<typeof task>,
  executions = [] as ReturnType<typeof execution>[],
) {
  return withSnapshot(
    snapshot({
      blocks: boardWith(block),
      pipelines: [buildPipeline, ralphPipeline],
      executions,
      agentConfigCatalog: catalog,
    }),
  )
}

const buildTask = task(buildPipeline.id, { 'coder.forkDecision': 'always' })

/**
 * The build pipeline runs the coder, so the coder's two options show. The fork decision is set
 * to Always propose; the reproduction proof keeps its default.
 */
export const Default: Story = {
  args: { block: buildTask },
  decorators: [withTask(buildTask)],
  play: opensTo((c) => c.findByText('Implementation-fork decision')),
}

/** The run is at the coder step, so both of its options are locked. */
export const Frozen: Story = {
  args: { block: buildTask },
  decorators: [withTask(buildTask, [execution()])],
  play: opensTo((c) => c.findAllByTitle('Frozen: the agent has started')),
}

const staleTask = task(buildPipeline.id, { 'playwright.e2eTarget': 'ephemeral' })

/**
 * The task chose an ephemeral environment for the Playwright step, then moved to a pipeline
 * without it. The choice stays listed after the coder's options, so it can still be changed.
 */
export const StaleValue: Story = {
  args: { block: staleTask },
  decorators: [withTask(staleTask)],
  play: opensTo((c) => c.findByText('E2E execution target')),
}

const ralphTask = task(ralphPipeline.id, { 'ralph.validationCommand': 'pnpm test' })

/**
 * The Ralph loop's two options are a text and a number field. The inspector draws only option
 * buttons, so each shows its label and description with no field to edit, and the command set
 * on the task does not show. The add-task form draws both fields.
 */
export const TextAndNumberOptions: Story = {
  args: { block: ralphTask },
  decorators: [withTask(ralphTask)],
  play: opensTo((c) => c.findByText('Max iterations')),
}
