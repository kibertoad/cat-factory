import { ConflictError, ValidationError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { failureFromAdvanceError, failureFromDriver, failureFromResult } from './runFailure.js'

// These derivations exist so the two durable drivers can't disagree about what a failure IS.
// The regression they encode: the Cloudflare driver silently dropped `reason` on every path.

describe('failureFromAdvanceError', () => {
  it("lifts a DomainError's machine reason onto the failure", () => {
    const failure = failureFromAdvanceError(
      new ConflictError('No agent backend', 'agent_backend_unconfigured'),
    )
    expect(failure).toEqual({
      message: 'No agent backend',
      kind: 'agent',
      detail: null,
      reason: 'agent_backend_unconfigured',
    })
  })

  it('reads a reason off a ValidationError too, not just conflicts', () => {
    const failure = failureFromAdvanceError(
      new ValidationError('No deploy runner', { reason: 'deploy_runner_unwired' }),
    )
    expect(failure.reason).toBe('deploy_runner_unwired')
  })

  it('leaves reason null for a plain Error and for a non-Error throw', () => {
    expect(failureFromAdvanceError(new Error('boom'))).toEqual({
      message: 'boom',
      kind: 'agent',
      detail: null,
      reason: null,
    })
    expect(failureFromAdvanceError('boom').message).toBe('boom')
  })
})

describe('failureFromResult', () => {
  it("keeps an inline gate's own classification, detail and reason", () => {
    expect(
      failureFromResult({
        kind: 'job_failed',
        error: 'unparseable verdict',
        failureKind: 'companion_rejected',
        detail: 'my reply got cut off',
        reason: 'deploy_runner_unwired',
      }),
    ).toEqual({
      message: 'unparseable verdict',
      kind: 'companion_rejected',
      detail: 'my reply got cut off',
      reason: 'deploy_runner_unwired',
    })
  })

  it('defaults an unclassified container-job failure to `job_failed`', () => {
    expect(
      failureFromResult({ kind: 'job_failed', error: 'container reported a failure' }),
    ).toEqual({
      message: 'container reported a failure',
      kind: 'job_failed',
      detail: null,
      reason: null,
    })
  })

  it("records an eviction as `evicted` with the transport's post-mortem as the detail", () => {
    expect(
      failureFromResult({ kind: 'job_evicted', error: 'container died', detail: 'OOMKilled' }),
    ).toEqual({ message: 'container died', kind: 'evicted', detail: 'OOMKilled', reason: null })
  })
})

describe('failureFromDriver', () => {
  it('carries no reason — a spent poll budget has no cause code to report', () => {
    expect(failureFromDriver('Gate precheck did not settle', 'timeout')).toEqual({
      message: 'Gate precheck did not settle',
      kind: 'timeout',
      detail: null,
      reason: null,
    })
  })
})
