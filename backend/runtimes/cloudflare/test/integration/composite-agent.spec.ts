import { describe, expect, it } from 'vitest'
import type {
  AgentJobHandle,
  AgentExecutor,
  AgentRunContext,
  AgentRunResult,
  RunReclaimTarget,
} from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { CompositeAgentExecutor } from '@cat-factory/server'

// CompositeAgentExecutor must send the repo-operating steps — implementation
// (`coder`), the mock builder (`mocker`), the Playwright e2e writer (`playwright`)
// and the container-backed reviewers (`reviewer` / `doc-reviewer`, which clone the
// PR branch to review the real repository) — to the container, leaving every other
// agent kind (the inline companions, the `acceptance` scenario writer, …) on the
// inline executor. With no container wired, the repo-operating kinds must throw
// rather than fall back to inline.

class Tagged implements AgentExecutor {
  constructor(private readonly tag: string) {}
  run(_context: AgentRunContext): Promise<AgentRunResult> {
    return Promise.resolve({ output: this.tag })
  }
}

// A container executor that records run reclaims, to assert the composite
// forwards reclaim to it (the engine narrows the composite, not the inner one).
class ReclaimableContainer implements AgentExecutor {
  readonly reclaimed: string[] = []
  run(_context: AgentRunContext): Promise<AgentRunResult> {
    return Promise.resolve({ output: 'container' })
  }
  runsAsync(_context: AgentRunContext): boolean {
    return true
  }
  startJob(_context: AgentRunContext): Promise<AgentJobHandle> {
    return Promise.resolve({ jobId: 'j' })
  }
  pollJob(): Promise<never> {
    throw new Error('not used')
  }
  reclaimRun(target: RunReclaimTarget): Promise<void> {
    this.reclaimed.push(target.runId)
    return Promise.resolve()
  }
}

function ctx(agentKind: string): AgentRunContext {
  return {
    agentKind,
    pipelineName: 'P',
    stepIndex: 0,
    isFinalStep: true,
    block: { title: 'T', type: 'service', description: 'D' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
  }
}

describe('CompositeAgentExecutor', () => {
  const composite = new CompositeAgentExecutor(new Tagged('inline'), new Tagged('container'))

  it('routes repo-operating kinds to the container executor', async () => {
    // `architect` runs in a container too (read-only repo exploration before proposing).
    // `tester`/`fixer` clone the PR branch (run the suite / push fixes), so both are
    // container kinds — the Tester→Fixer loop dispatches both through this executor.
    // `reviewer`/`doc-reviewer` are container-backed companions: they clone the producer's
    // PR branch and review the REAL repository (a summary-only review is worthless).
    for (const kind of [
      'coder',
      'mocker',
      'playwright',
      'architect',
      'tester-api',
      'fixer',
      'reviewer',
      'doc-reviewer',
    ]) {
      expect((await composite.run(ctx(kind))).output).toBe('container')
    }
  })

  it('routes other kinds to the inline executor', async () => {
    // The INLINE companions (architect-companion / spec-companion) review prose output and
    // stay inline; the container-backed reviewers are asserted above.
    for (const kind of ['architect-companion', 'spec-companion', 'documenter', 'custom-x']) {
      expect((await composite.run(ctx(kind))).output).toBe('inline')
    }
  })

  it('throws for repo-operating kinds when no container is wired (no inline fallback)', async () => {
    const noSandbox = new CompositeAgentExecutor(new Tagged('inline'), null)
    for (const kind of [
      'coder',
      'mocker',
      'playwright',
      'blueprints',
      'business-documenter',
      'architect',
      'tester-api',
      'fixer',
      // Container-backed companions need a checkout like any other container kind.
      'reviewer',
      'doc-reviewer',
    ]) {
      // pick() throws synchronously, so run()/runsAsync()/startJob() all throw.
      expect(() => noSandbox.run(ctx(kind))).toThrow(/needs a real checkout/)
      expect(() => noSandbox.runsAsync(ctx(kind))).toThrow(/needs a real checkout/)
      expect(() => noSandbox.startJob(ctx(kind))).toThrow(/needs a real checkout/)
    }
    // Non-sandbox kinds still run inline even with no container.
    expect((await noSandbox.run(ctx('documenter'))).output).toBe('inline')
  })

  it('routes a registered container kind to the container executor', async () => {
    // App-owned DI: register the custom kinds on a fresh registry and inject it into the composite.
    const registry = defaultAgentKindRegistry()
    registry.register({
      kind: 'org-security-auditor',
      systemPrompt: 'You audit the change for security issues.',
      requiresContainer: true,
    })
    // A registered inline kind (no requiresContainer) stays on the inline executor.
    registry.register({ kind: 'org-planner', systemPrompt: 'You plan the work.' })
    const c = new CompositeAgentExecutor(new Tagged('inline'), new Tagged('container'), registry)
    expect((await c.run(ctx('org-security-auditor'))).output).toBe('container')
    expect((await c.run(ctx('org-planner'))).output).toBe('inline')
  })

  it('throws for a registered container kind when no container is wired', () => {
    const registry = defaultAgentKindRegistry()
    registry.register({
      kind: 'org-security-auditor',
      systemPrompt: 'You audit the change.',
      requiresContainer: true,
    })
    const noSandbox = new CompositeAgentExecutor(new Tagged('inline'), null, registry)
    expect(() => noSandbox.run(ctx('org-security-auditor'))).toThrow(/needs a real checkout/)
  })

  it('forwards the run reclaim to the container executor', async () => {
    const container = new ReclaimableContainer()
    const c = new CompositeAgentExecutor(new Tagged('inline'), container)
    await c.reclaimRun({ runId: 'exec-1', jobId: 'exec-1-coder', agentKinds: ['coder'] })
    expect(container.reclaimed).toEqual(['exec-1'])
  })

  it('the run reclaim is a no-op when no container is wired', async () => {
    const c = new CompositeAgentExecutor(new Tagged('inline'), null)
    await expect(
      c.reclaimRun({ runId: 'exec-1', jobId: 'exec-1-coder', agentKinds: [] }),
    ).resolves.toBeUndefined()
  })
})

// The THIRD arm. Its failure mode is the quiet one: a delegated kind answers `false` to both
// predicates the other two arms route on, so without an arm of its own it falls through to the
// inline executor: a one-shot LLM call over an implementer's prompt, producing confident prose
// and no branch, with the run then advancing into a `ci` gate that has nothing to check.
describe('CompositeAgentExecutor: delegated kinds', () => {
  function delegatedRegistry() {
    const registry = defaultAgentKindRegistry()
    registry.register({
      kind: 'acme:impl',
      systemPrompt: 'You implement the change.',
      agent: { surface: 'delegated', executor: 'acme:executor' },
    })
    return registry
  }

  it('routes a delegated kind to the delegated arm, never to inline', async () => {
    const c = new CompositeAgentExecutor(
      new Tagged('inline'),
      new Tagged('container'),
      delegatedRegistry(),
      new Tagged('delegated'),
    )
    expect((await c.run(ctx('acme:impl'))).output).toBe('delegated')
    // …and nothing else moved.
    expect((await c.run(ctx('coder'))).output).toBe('container')
    expect((await c.run(ctx('acceptance'))).output).toBe('inline')
  })

  it('throws for a delegated kind when no delegated executor is wired', () => {
    // The same disposition an unwired container kind gets, for the same reason.
    const c = new CompositeAgentExecutor(
      new Tagged('inline'),
      new Tagged('container'),
      delegatedRegistry(),
    )
    expect(() => c.run(ctx('acme:impl'))).toThrow(/external \(delegated\) executor/)
  })

  it('ROUTES the poll off the handle rather than assuming the container', async () => {
    // A poll rebuilds its handle from the persisted step. Hard-routing to the container polls one
    // that was never started and settles the step against nothing.
    const polled: string[] = []
    const delegated: AgentExecutor = {
      run: () => Promise.resolve({ output: 'delegated' }),
      runsAsync: () => true,
      startJob: () => Promise.resolve({ jobId: 'j' }),
      pollJob: (handle: AgentJobHandle) => {
        polled.push(handle.delegated!.executor)
        return Promise.resolve({ state: 'running' as const })
      },
    } as AgentExecutor
    const c = new CompositeAgentExecutor(
      new Tagged('inline'),
      new ReclaimableContainer(),
      delegatedRegistry(),
      delegated,
    )
    await c.pollJob({
      jobId: 'j',
      delegated: { executor: 'acme:executor', externalId: 'run-99' },
    })
    expect(polled).toEqual(['acme:executor'])
  })

  it('reclaims BOTH arms, and the delegated one ANSWERS', async () => {
    // A run can hold a container and external work at once (a delegated implementer followed by a
    // container fixer), so reclaiming one is not reclaiming the run.
    const container = new ReclaimableContainer()
    const delegated: AgentExecutor = {
      run: () => Promise.resolve({ output: 'delegated' }),
      runsAsync: () => true,
      startJob: () => Promise.resolve({ jobId: 'j' }),
      pollJob: () => Promise.resolve({ state: 'running' as const }),
      reclaimRun: () =>
        Promise.resolve({ delegations: [{ correlationKey: 'k', cancelled: true }] }),
    } as AgentExecutor
    const c = new CompositeAgentExecutor(
      new Tagged('inline'),
      container,
      delegatedRegistry(),
      delegated,
    )
    const report = await c.reclaimRun({
      runId: 'exec-1',
      jobId: 'exec-1-acme:impl',
      agentKinds: ['acme:impl'],
      delegations: [
        {
          executor: 'acme:executor',
          correlationKey: 'k',
          workspaceId: 'ws',
          blockId: 'blk_1',
          runId: 'exec-1',
          agentKind: 'acme:impl',
        },
      ],
    })
    expect(container.reclaimed).toEqual(['exec-1'])
    expect(report).toEqual({ delegations: [{ correlationKey: 'k', cancelled: true }] })
  })

  it('still cancels the external work when the CONTAINER reclaim throws', async () => {
    // The two arms are independent resources. An unguarded container reclaim propagated before the
    // delegated one ran, so `applyDelegationCancellation` recorded every live delegation as
    // "could not stop the external work" while the executor that could stop it was never asked,
    // and the external run carried on, opened its pull request and billed its tokens.
    const container: AgentExecutor = {
      run: () => Promise.resolve({ output: 'container' }),
      runsAsync: () => true,
      startJob: () => Promise.resolve({ jobId: 'j' }),
      pollJob: () => Promise.resolve({ state: 'running' as const }),
      reclaimRun: () => Promise.reject(new Error('DO reclaim exploded')),
    } as AgentExecutor
    const cancelled: string[] = []
    const delegated: AgentExecutor = {
      run: () => Promise.resolve({ output: 'delegated' }),
      runsAsync: () => true,
      startJob: () => Promise.resolve({ jobId: 'j' }),
      pollJob: () => Promise.resolve({ state: 'running' as const }),
      reclaimRun: (target: RunReclaimTarget) => {
        for (const handle of target.delegations ?? []) cancelled.push(handle.correlationKey)
        return Promise.resolve({ delegations: [{ correlationKey: 'k', cancelled: true }] })
      },
    } as AgentExecutor
    const c = new CompositeAgentExecutor(
      new Tagged('inline'),
      container,
      delegatedRegistry(),
      delegated,
    )
    const report = await c.reclaimRun({
      runId: 'exec-1',
      jobId: 'exec-1-acme:impl',
      agentKinds: ['acme:impl'],
      delegations: [
        {
          executor: 'acme:executor',
          correlationKey: 'k',
          workspaceId: 'ws',
          blockId: 'blk_1',
          runId: 'exec-1',
          agentKind: 'acme:impl',
        },
      ],
    })
    expect(cancelled).toEqual(['k'])
    expect(report).toEqual({ delegations: [{ correlationKey: 'k', cancelled: true }] })
  })

  it('NAMES external work it cannot stop, instead of reporting a clean teardown', async () => {
    const c = new CompositeAgentExecutor(new Tagged('inline'), null, delegatedRegistry())
    const report = await c.reclaimRun({
      runId: 'exec-1',
      jobId: 'exec-1-acme:impl',
      agentKinds: ['acme:impl'],
      delegations: [
        {
          executor: 'acme:executor',
          correlationKey: 'k',
          workspaceId: 'ws',
          blockId: 'blk_1',
          runId: 'exec-1',
          agentKind: 'acme:impl',
        },
      ],
    })
    expect(report).toMatchObject({ delegations: [{ correlationKey: 'k', cancelled: false }] })
  })
})
