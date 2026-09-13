import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import {
  defaultDelegatedExecutorRegistry,
  defaultGateRegistry,
  defaultPipelineRegistry,
  DelegatedExecutorRegistrationError,
  type DelegatedExecutorDefinition,
  type DelegatedExecutorRegistry,
} from '@cat-factory/kernel'
import { collectRegistrationProblems } from './validateRegistrations.js'

// Boot validation for the DELEGATED surface. All three faults below are silent at run time in
// different ways, which is why boot grades each rather than letting a dispatch discover it: a
// delegated kind with no executor throws hours into whichever pipeline reached it first, a
// non-delegated kind carrying one is a declaration nobody reads (the deployment believes a step
// runs on its own CI while every run goes through the platform's harness), and an unregistered id
// can never be resolved at all.

const EXECUTOR: DelegatedExecutorDefinition = {
  id: 'acme:executor',
  presentation: { label: 'Acme', icon: 'i-lucide-bot', description: 'Acme runs the change' },
  poll: { intervalMs: 60_000, maxDurationMs: 3_600_000 },
  telemetry: 'not-reported',
  create: () => ({
    start: async () => ({ externalId: 'x' }),
    poll: async () => ({ state: 'running' }),
  }),
}

function problems(
  kinds: Parameters<ReturnType<typeof defaultAgentKindRegistry>['register']>[0][],
  executors?: DelegatedExecutorRegistry,
) {
  const agentKindRegistry = defaultAgentKindRegistry()
  for (const kind of kinds) agentKindRegistry.register(kind)
  return collectRegistrationProblems({
    registries: {
      agentKindRegistry,
      gateRegistry: defaultGateRegistry(),
      pipelineRegistry: defaultPipelineRegistry(),
      ...(executors ? { delegatedExecutorRegistry: executors } : {}),
    },
  }).map((p) => p.code)
}

function registryWith(definition: DelegatedExecutorDefinition): DelegatedExecutorRegistry {
  const registry = defaultDelegatedExecutorRegistry()
  registry.register(definition)
  return registry
}

describe('delegated-executor boot validation', () => {
  it('accepts a delegated kind whose executor this build registers', () => {
    expect(
      problems(
        [
          {
            kind: 'acme:impl',
            systemPrompt: 'implement',
            agent: { surface: 'delegated', executor: 'acme:executor' },
          },
        ],
        registryWith(EXECUTOR),
      ),
    ).toEqual([])
  })

  it('refuses a delegated kind that names no executor', () => {
    expect(
      problems(
        [{ kind: 'acme:impl', systemPrompt: 'implement', agent: { surface: 'delegated' } }],
        registryWith(EXECUTOR),
      ),
    ).toContain('agent_executor_missing')
  })

  it('refuses an executor declared on a surface that runs HERE', () => {
    // The more dangerous of the two: the declaration is read by nothing, so the deployment
    // believes a step leaves the platform while every run of it goes through the harness.
    expect(
      problems(
        [
          {
            kind: 'acme:coder',
            systemPrompt: 'implement',
            agent: { surface: 'container-coding', executor: 'acme:executor' },
          },
        ],
        registryWith(EXECUTOR),
      ),
    ).toContain('agent_executor_on_non_delegated_surface')
  })

  it('refuses a delegated kind naming an executor nobody registered', () => {
    expect(
      problems(
        [
          {
            kind: 'acme:impl',
            systemPrompt: 'implement',
            agent: { surface: 'delegated', executor: 'acme:missing' },
          },
        ],
        registryWith(EXECUTOR),
      ),
    ).toContain('agent_executor_unknown')
  })

  it('stands the resolvability check DOWN when no registry was supplied', () => {
    // An absent registry is "we cannot see the set", not "the set is empty", the same rule every
    // other cross-registry check here follows. The presence checks still run.
    expect(
      problems([
        {
          kind: 'acme:impl',
          systemPrompt: 'implement',
          agent: { surface: 'delegated', executor: 'acme:missing' },
        },
      ]),
    ).toEqual([])
  })
})

describe('DelegatedExecutorRegistry.register', () => {
  it('refuses an id that is not namespaced', () => {
    // An unnamespaced id is how two deployments' shared composition modules collide on
    // `executor`, and the loser's kinds then dispatch to the winner's external system.
    expect(() =>
      defaultDelegatedExecutorRegistry().register({ ...EXECUTOR, id: 'executor' }),
    ).toThrow(DelegatedExecutorRegistrationError)
  })

  it('refuses a window shorter than one poll interval', () => {
    // The step would be failed as un-settled before the platform ever asked how it was going.
    expect(() =>
      defaultDelegatedExecutorRegistry().register({
        ...EXECUTOR,
        poll: { intervalMs: 60_000, maxDurationMs: 1_000 },
      }),
    ).toThrow(DelegatedExecutorRegistrationError)
  })

  it('lets a later registration replace an earlier one under the same id', () => {
    const registry = defaultDelegatedExecutorRegistry()
    registry.register(EXECUTOR)
    registry.register({ ...EXECUTOR, telemetry: 'self-reported' })
    expect(registry.get('acme:executor')?.telemetry).toBe('self-reported')
    expect(registry.size).toBe(1)
  })

  it('projects identity for the palette and never the factory', () => {
    expect(registryWith(EXECUTOR).views()).toEqual([
      {
        id: 'acme:executor',
        label: 'Acme',
        icon: 'i-lucide-bot',
        description: 'Acme runs the change',
        telemetry: 'not-reported',
      },
    ])
  })
})
