import type {
  AgentJobHandle,
  RunnerJobResult,
  RunnerJobView,
  RunnerReproductionReport,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import {
  buildFailureMeta,
  buildRunningUpdate,
  settledRunResult,
  toRunResult,
} from './containerAgentResult.js'

/** The registry every facade builds; the kind is irrelevant to the orthogonal channels below. */
const registry = defaultAgentKindRegistry()

// The BUGFIX REPRODUCTION PROOF's crossing of the runner→engine boundary. The harness half is
// covered against a real git repo in `executor-harness/test/reproduction-proof.test.ts`; what
// these pin is the plumbing, where the failure mode is silent — a verdict dropped here does not
// throw, it just leaves the pull request with no reproduction section, which reads exactly like a
// run that never ran the phase.

const REPRODUCED: RunnerReproductionReport = {
  status: 'reproduced',
  command: 'npm test -- repro',
  testPaths: ['a.test.ts'],
  attempts: 2,
  maxAttempts: 3,
  base: { exitCode: 1, passed: false, outputTail: 'BUG REPRODUCED' },
  final: { exitCode: 0, passed: true },
  at: 1_700_000_000_000,
}

const INCONCLUSIVE: RunnerReproductionReport = {
  ...REPRODUCED,
  status: 'inconclusive',
  final: { exitCode: 1, passed: false },
  note: 'The declared check FAILED on both trees.',
}

describe('toRunResult — the reproduction proof on the terminal result', () => {
  it('attaches the verdict to a SUCCESSFUL run, alongside the opened PR', () => {
    const result: RunnerJobResult = {
      pushed: true,
      prUrl: 'https://github.com/o/r/pull/9',
      reproductionReport: REPRODUCED,
    }

    expect(toRunResult(result, undefined, registry).reproductionReport).toEqual(REPRODUCED)
  })

  it('attaches an INCONCLUSIVE verdict too — it is evidence, not a failure', () => {
    // The proof never gates the PR: an unproven reproduction means the EVIDENCE is weak, which is
    // a reviewer's call. Dropping the report for that verdict would leave the reader unable to
    // tell "we tried and could not demonstrate it" from "nobody tried".
    const result: RunnerJobResult = { pushed: true, reproductionReport: INCONCLUSIVE }

    expect(toRunResult(result, undefined, registry).reproductionReport).toEqual(INCONCLUSIVE)
  })

  it('coexists with the other orthogonal channels rather than displacing them', () => {
    const result: RunnerJobResult = {
      pushed: true,
      reproductionReport: REPRODUCED,
      validationReport: { passed: true, attempts: 1, maxAttempts: 3, outcomes: [], at: 1 },
      effortReport: { difficulty: 3 },
    }
    const mapped = toRunResult(result, undefined, registry)

    expect(mapped.reproductionReport).toEqual(REPRODUCED)
    expect(mapped.validationReport).toBeDefined()
    expect(mapped.effortReport).toBeDefined()
  })

  it('sets nothing for a job that carried no reproduction declaration', () => {
    expect(toRunResult({ pushed: true }, undefined, registry).reproductionReport).toBeUndefined()
  })
})

describe('buildRunningUpdate — the LIVE verdict', () => {
  it('forwards the latest published attempt on every poll', () => {
    // A published attempt is FINAL and the harness republishes a whole new one per repair round,
    // so forwarding the latest is safe — and is what makes a failed verification visible while
    // the loop is still running.
    const view: RunnerJobView = { state: 'running', reproductionReport: INCONCLUSIVE }

    expect(buildRunningUpdate(view, {}).reproductionReport).toEqual(INCONCLUSIVE)
  })

  it('omits it for a run with no proof phase', () => {
    expect(buildRunningUpdate({ state: 'running' }, {}).reproductionReport).toBeUndefined()
  })
})

describe('buildFailureMeta — a verdict that outlives the job', () => {
  it('prefers the terminal result over the last live publish', () => {
    // Terminal-first, view-fallback: the result envelope is authoritative when the transport
    // forwards one.
    const view: RunnerJobView = {
      state: 'failed',
      reproductionReport: INCONCLUSIVE,
      result: { pushed: false, reproductionReport: REPRODUCED },
    }

    expect(buildFailureMeta(view).reproductionReport).toEqual(REPRODUCED)
  })

  it('falls back to the live publish when the transport forwards no terminal body', () => {
    const view: RunnerJobView = { state: 'failed', reproductionReport: INCONCLUSIVE }

    expect(buildFailureMeta(view).reproductionReport).toEqual(INCONCLUSIVE)
  })

  it('keeps a verdict on a job that died for an UNRELATED reason', () => {
    // A failed verification never fails a job by itself, so a report present on a failed view
    // describes work that genuinely happened and is worth keeping.
    const view: RunnerJobView = {
      state: 'failed',
      failureCause: 'inactivity-timeout',
      reproductionReport: REPRODUCED,
    }
    const meta = buildFailureMeta(view)

    expect(meta.failureCause).toBe('inactivity-timeout')
    expect(meta.reproductionReport).toEqual(REPRODUCED)
  })

  it('sets nothing when no proof ran', () => {
    expect(buildFailureMeta({ state: 'failed' }).reproductionReport).toBeUndefined()
  })
})

// What only the dispatch HANDLE knows, folded onto a settled result. Both channels fail SILENTLY
// when dropped: the ledger books provider "unknown" / model "" for the model, and a cache-heavy
// subscription run is priced entirely at the fresh rate for the class split.

const handle = (over: Partial<AgentJobHandle> = {}): AgentJobHandle => ({
  jobId: 'job_1',
  model: 'claude:claude-opus-5',
  ...over,
})

describe('settledRunResult - the dispatch handle folded onto a settled job', () => {
  it('prices a subscription run by input CLASS off the same per-call rows that mark it as one', () => {
    const result: RunnerJobResult = {
      pushed: true,
      usage: { inputTokens: 10_000, outputTokens: 500 },
      callMetrics: [
        { cacheReadTokens: 8_000, cacheWriteTokens: 500 },
        { cacheReadTokens: 1_000, cacheWriteTokens: 0 },
      ],
    } as RunnerJobResult
    const mapped = settledRunResult(result, handle({ provider: 'claude' }), registry)
    expect(mapped.usage).toEqual({
      inputTokens: 10_000,
      outputTokens: 500,
      // The harness total stays authoritative and the classes sum to exactly it; only the cache
      // shares come off the calls, so the turn they narrated nothing for is priced as fresh.
      inputClasses: { promptTokens: 500, cacheReadTokens: 9_000, cacheWriteTokens: 500 },
    })
    expect(mapped.usageBilling).toBe('subscription')
    expect(mapped.usageVendor).toBe('claude')
    expect(mapped.model).toBe('claude:claude-opus-5')
  })

  it('leaves usage off a proxy-metered run, which the proxy alone meters', () => {
    // Pi emits no `callMetrics`. Stamping its usage here too would double-count every token it
    // spent, since the proxy already recorded them.
    const result = {
      pushed: true,
      usage: { inputTokens: 10_000, outputTokens: 500 },
    } as RunnerJobResult
    const mapped = settledRunResult(result, handle(), registry)
    expect(mapped.usage).toBeUndefined()
    expect(mapped.usageBilling).toBeUndefined()
    expect(mapped.model).toBe('claude:claude-opus-5')
  })

  it('falls back to the provider parsed from the model label when the handle carries none', () => {
    const result = {
      pushed: true,
      usage: { inputTokens: 100, outputTokens: 10 },
      callMetrics: [{ cacheReadTokens: 0, cacheWriteTokens: 0 }],
    } as RunnerJobResult
    expect(settledRunResult(result, handle(), registry).usageVendor).toBe('claude')
  })

  it('leaves the mapping to decide the model when the dispatch captured no label', () => {
    const mapped = settledRunResult(
      { pushed: true } as RunnerJobResult,
      handle({ model: undefined }),
      registry,
    )
    expect(mapped.model).toBeUndefined()
  })
})
