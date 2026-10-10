import {
  definePipeline,
  type DelegatedExecutor,
  type DelegatedExecutorDefinition,
  type DelegatedExecutorDeps,
  type DelegatedExecutorRegistry,
  type DelegationBrief,
  type DelegationHandle,
  type DelegationUpdate,
  type Pipeline,
  type PipelineRegistry,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// A worked example of the DELEGATED-EXECUTOR seam: a deployment plugging in a system it already
// runs as the executor of ONE pipeline step, while cat-factory keeps everything around it.
//
// It is deliberately the smallest honest thing. The registration below is what a company writes;
// the executor it registers is a fake, so this package runs on a laptop with no external system,
// no credentials and no network, which is the point. The seam is what is being demonstrated, not
// anybody's CI.
//
// Read it alongside `example-custom-agent`, which is the same demonstration for the OTHER kind of
// extension (a kind that runs in the platform's own harness).
// ---------------------------------------------------------------------------

/** The executor id. NAMESPACED, which the registry requires: see why in its `register`. */
export const EXAMPLE_EXECUTOR_ID = 'example:delegated'

/** The agent kind that runs on it. */
export const EXAMPLE_DELEGATED_KIND = 'example-delegated-implementer'

/** The pipeline that keeps the platform's own CI gate and merge tail around the external step. */
export const EXAMPLE_DELEGATED_PIPELINE_ID = 'pl_example_delegated'

/**
 * The fake external system: a map of correlation key → what it "is doing".
 *
 * Exported so a test (or someone poking at the example) can drive it. A real executor holds a
 * client instead; what it must NOT hold is per-run state that outlives a process, because a poll
 * routinely runs somewhere else, which is exactly why the platform persists the handle.
 */
export class FakeExternalSystem {
  private readonly runs = new Map<string, { polls: number; url: string }>()

  start(correlationKey: string): { externalId: string; url: string } {
    const existing = this.runs.get(correlationKey)
    // IDEMPOTENT per correlation key. The port requires it and a real executor has to arrange it
    // too: both durable drivers replay, and a second start is a second pull request for one task.
    if (existing) return { externalId: correlationKey, url: existing.url }
    const url = `https://example.invalid/runs/${encodeURIComponent(correlationKey)}`
    this.runs.set(correlationKey, { polls: 0, url })
    return { externalId: correlationKey, url }
  }

  /** Two polls "running", then done with a pull request: the shape of an ordinary producer. */
  poll(correlationKey: string, branch: string | undefined): DelegationUpdate {
    const run = this.runs.get(correlationKey)
    if (!run) return { state: 'failed', error: 'No such run in the example system.' }
    run.polls += 1
    if (run.polls < 3) return { state: 'running', url: run.url, phase: 'building' }
    return {
      state: 'done',
      result: {
        summary: 'The example executor implemented the change and opened a pull request.',
        ...(branch
          ? {
              pullRequest: {
                url: 'https://example.invalid/pull/1',
                number: 1,
                branch,
              },
            }
          : {}),
      },
    }
  }

  cancel(correlationKey: string): void {
    this.runs.delete(correlationKey)
  }
}

/**
 * The definition a deployment registers. This is the whole of it: identity for the palette, the
 * credential key names (none here, since the fake authenticates nothing), the cadence the driver
 * polls on, what the platform may claim about telemetry, and a factory.
 *
 * `telemetry: 'not-reported'` is the honest declaration for a system that files no LLM usage, and
 * it is what makes the run views SAY "usage not reported by …" instead of rendering a zero beside
 * a container step's real number.
 */
export function exampleDelegatedExecutor(system = new FakeExternalSystem()): {
  definition: DelegatedExecutorDefinition
  system: FakeExternalSystem
} {
  const definition: DelegatedExecutorDefinition = {
    id: EXAMPLE_EXECUTOR_ID,
    presentation: {
      label: 'Example external executor',
      icon: 'i-lucide-bot',
      description: 'A stand-in for a system this deployment already runs.',
    },
    poll: { intervalMs: 5_000, maxDurationMs: 600_000 },
    telemetry: 'not-reported',
    // The fake system pushes nothing, so nothing needs a ref: the platform writes no branch and a
    // run that produced no work leaves none behind. A real GitHub-Actions executor declares
    // 'platform-creates' instead, because `actions/checkout` on a branch that is not there fails
    // the job before any of the work begins.
    workBranch: 'executor-creates',
    create: (deps: DelegatedExecutorDeps): DelegatedExecutor => {
      const log = deps.logger.child({ executor: EXAMPLE_EXECUTOR_ID })
      return {
        async start(brief: DelegationBrief) {
          log.info('starting example external work', {
            correlationKey: brief.correlationKey,
            repo: `${brief.repo.owner}/${brief.repo.name}`,
            branch: brief.branches.work,
          })
          return system.start(brief.correlationKey)
        },
        async poll(handle: DelegationHandle) {
          // The branch comes off the HANDLE, not off a brief: a poll runs after the dispatch, in
          // another process, and the platform persists exactly what it needs for this.
          return system.poll(handle.correlationKey, handle.branches?.work)
        },
        async cancel(handle: DelegationHandle) {
          system.cancel(handle.correlationKey)
        },
      }
    },
  }
  return { definition, system }
}

/**
 * The agent kind. `surface: 'delegated'` plus the executor id is the whole declaration; the rest
 * of the registration is what any kind carries.
 *
 * Its `systemPrompt` still matters: the platform composes the brief the external system is handed
 * from it, with the workspace's best-practice standards and prompt overrides folded in exactly as
 * they are for a container kind. That is what the deployment gets by plugging in HERE rather than
 * wiring its CI to a webhook.
 */
export function registerExampleDelegatedKind(registry: AgentKindRegistry): void {
  registry.register({
    kind: EXAMPLE_DELEGATED_KIND,
    systemPrompt:
      'You implement the requested change end to end: read the task, make the change on the ' +
      'work branch, and open a pull request describing what you did and why.',
    traits: ['code-aware'],
    agent: { surface: 'delegated', executor: EXAMPLE_EXECUTOR_ID },
    presentation: {
      label: 'External implementer',
      icon: 'i-lucide-bot',
      color: '#6366f1',
      description: 'Implements the change on the deployment’s own executor.',
      category: 'build',
    },
  })
}

/**
 * The pipeline, and the reason this example exists as a pipeline at all: everything after the
 * delegated step is the platform's ordinary engine.
 *
 * The `ci` gate polls the REAL checks on the pull request the external system opened, and the
 * `merger` applies the workspace's risk policy and merges for real. A deployment gets its Jira
 * intake, its Slack notifications, its merge track record and its verification report around a
 * step it implemented nothing for.
 */
export function exampleDelegatedPipeline(): Pipeline {
  return definePipeline({
    id: EXAMPLE_DELEGATED_PIPELINE_ID,
    name: 'External implementation',
    description: 'Implement on the deployment’s own executor, then gate on CI and merge here.',
    purpose: 'build',
    steps: [{ kind: EXAMPLE_DELEGATED_KIND }, { kind: 'merger' }],
  })
}

/** Register the whole example on the app-owned registries a facade injects. */
export function registerExampleDelegation(registries: {
  agentKindRegistry: AgentKindRegistry
  delegatedExecutorRegistry: DelegatedExecutorRegistry
  pipelineRegistry: PipelineRegistry
  system?: FakeExternalSystem
}): FakeExternalSystem {
  const { definition, system } = exampleDelegatedExecutor(registries.system)
  registries.delegatedExecutorRegistry.register(definition)
  registerExampleDelegatedKind(registries.agentKindRegistry)
  registries.pipelineRegistry.register(exampleDelegatedPipeline())
  return system
}
