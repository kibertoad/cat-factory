import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentJobHandle,
  AgentExecutor,
  AgentRunContext,
  AgentRunResult,
} from '@cat-factory/kernel'
import { clearRegisteredAgentKinds, registerAgentKind } from '@cat-factory/agents'
import { CompositeAgentExecutor } from '../../src/infrastructure/ai/CompositeAgentExecutor'

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

// A container executor that records stopJob calls, to assert the composite
// forwards reclaim to it (the engine narrows the composite, not the inner one).
class StoppableContainer implements AgentExecutor {
  readonly stopped: string[] = []
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
  stopJob(handle: AgentJobHandle): Promise<void> {
    this.stopped.push(handle.jobId)
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
    registerAgentKind({
      kind: 'org-security-auditor',
      systemPrompt: 'You audit the change for security issues.',
      requiresContainer: true,
    })
    // A registered inline kind (no requiresContainer) stays on the inline executor.
    registerAgentKind({ kind: 'org-planner', systemPrompt: 'You plan the work.' })
    expect((await composite.run(ctx('org-security-auditor'))).output).toBe('container')
    expect((await composite.run(ctx('org-planner'))).output).toBe('inline')
  })

  it('throws for a registered container kind when no container is wired', () => {
    registerAgentKind({
      kind: 'org-security-auditor',
      systemPrompt: 'You audit the change.',
      requiresContainer: true,
    })
    const noSandbox = new CompositeAgentExecutor(new Tagged('inline'), null)
    expect(() => noSandbox.run(ctx('org-security-auditor'))).toThrow(/needs a real checkout/)
  })

  afterEach(() => clearRegisteredAgentKinds())

  it('forwards stopJob to the container executor', async () => {
    const container = new StoppableContainer()
    const c = new CompositeAgentExecutor(new Tagged('inline'), container)
    await c.stopJob({ jobId: 'exec-1' })
    expect(container.stopped).toEqual(['exec-1'])
  })

  it('stopJob is a no-op when no container is wired', async () => {
    const c = new CompositeAgentExecutor(new Tagged('inline'), null)
    await expect(c.stopJob({ jobId: 'exec-1' })).resolves.toBeUndefined()
  })
})
