import { describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import type { AgentFailureKind } from '~/types/execution'
import { AGENT_FAILURE_KINDS } from '~/utils/failureKinds'
import {
  FAILURE_CAUSE_KEYS,
  failureCauseKey,
  presentFailure,
  type FailureContext,
} from '~/utils/failureCause'

/** The `en` message at a dotted key, or undefined when the key does not exist. */
function message(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
  }, en)
}

const task: FailureContext = { runKind: 'execution', localMode: false }
const bootstrap: FailureContext = { runKind: 'bootstrap', localMode: false }
const repair: FailureContext = { runKind: 'env-config-repair', localMode: false }

describe('presentFailure', () => {
  it('gives every failure kind a cause line that exists in the catalog, for both run kinds', () => {
    // The relation, not a count: each kind the contract declares resolves to a real `en` string,
    // so a kind added later fails here by name if its line is missing.
    for (const kind of AGENT_FAILURE_KINDS) {
      for (const context of [task, bootstrap, repair]) {
        const { causeKey } = presentFailure({ kind, reason: null }, context)
        expect(typeof message(causeKey), `${context.runKind} ${kind}`).toBe('string')
      }
      expect(presentFailure({ kind, reason: null }, task).causeKey).toBe(FAILURE_CAUSE_KEYS[kind])
    }
  })

  it('names a kind that a release retired as unknown, not as a missing key', () => {
    // A stored run can still hold a kind the type no longer lists.
    const retired = { kind: 'retired_kind' as AgentFailureKind, reason: null }
    expect(failureCauseKey(retired, task)).toBe(FAILURE_CAUSE_KEYS.unknown)
  })

  it('gives a single-job run its own line where the kind means something different', () => {
    for (const context of [bootstrap, repair]) {
      for (const kind of ['evicted', 'timeout', 'agent'] as const) {
        const key = presentFailure({ kind, reason: null }, context).causeKey
        expect(key, `${context.runKind} ${kind}`).toBe(`board.failure.cause.singleJob.${kind}`)
      }
    }
    // A kind that reads the same for both runs keeps the shared line.
    expect(presentFailure({ kind: 'dispatch', reason: null }, bootstrap).causeKey).toBe(
      FAILURE_CAUSE_KEYS.dispatch,
    )
  })

  it('offers Retry for every kind that a setting or a new run does not fix', () => {
    const special = new Set(['environment', 'state_unreadable'])
    for (const kind of AGENT_FAILURE_KINDS.filter((k) => !special.has(k))) {
      expect(presentFailure({ kind, reason: null }, task).action, kind).toBe('retry')
    }
  })

  it('starts a new run when the run state cannot be read, because a retry reads it again', () => {
    expect(presentFailure({ kind: 'state_unreadable', reason: null }, task).action).toBe('newRun')
  })

  it('opens the repository-host connection when no host is connected, whatever the kind', () => {
    // A retry fails again until the host is connected, so Retry is not the action here.
    for (const kind of ['preflight', 'agent', 'unknown'] as const) {
      const presented = presentFailure({ kind, reason: 'github_not_connected' }, task)
      expect(presented, kind).toEqual({
        causeKey: 'errors.conflict.description.github_not_connected',
        action: 'connectRepoHost',
      })
    }
    expect(typeof message('errors.conflict.description.github_not_connected')).toBe('string')
  })

  it('sends an unwired deploy runner to the runner-pool tab on a hosted deployment', () => {
    const failure = { kind: 'environment', reason: 'deploy_runner_unwired' } as const
    expect(presentFailure(failure, task)).toEqual({
      causeKey: FAILURE_CAUSE_KEYS.environment,
      action: 'runnerPoolSetup',
    })
  })

  it('names the .env fix for an unwired deploy runner on a local node, with Retry', () => {
    // No settings tab fixes this on a local node, so the cause line names the fix and the
    // action is Retry, for after the variable is set.
    const failure = { kind: 'environment', reason: 'deploy_runner_unwired' } as const
    const presented = presentFailure(failure, { runKind: 'execution', localMode: true })
    expect(presented).toEqual({
      causeKey: 'board.failure.cause.deployRunnerUnwiredLocal',
      action: 'retry',
    })
    expect(typeof message(presented.causeKey)).toBe('string')
  })

  it('sends every other environment failure to the environment tab', () => {
    for (const localMode of [false, true]) {
      expect(
        presentFailure({ kind: 'environment', reason: null }, { runKind: 'execution', localMode })
          .action,
      ).toBe('environmentSetup')
    }
  })
})
