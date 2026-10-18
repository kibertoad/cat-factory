import { describe, expect, it } from 'vitest'
import { CONFLICT_REASONS } from '@cat-factory/contracts'
import en from '../../i18n/locales/en.json'
import type { AgentFailureKind } from '~/types/execution'
import { AGENT_FAILURE_KINDS } from '~/utils/failureKinds'
import { BESPOKE_CONFLICT_FIXES, CONFLICT_INFO } from '~/utils/conflictCopy'
import {
  FAILURE_CAUSE_KEYS,
  failureOutput,
  isLocalDeployRunnerUnwired,
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
const local: FailureContext = { runKind: 'execution', localMode: true }

describe('presentFailure', () => {
  it('gives every failure kind a cause line that exists in the catalog, for every run kind', () => {
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
    expect(presentFailure(retired, task).causeKey).toBe(FAILURE_CAUSE_KEYS.unknown)
  })

  it('gives a single-job run its own line where the kind means something different', () => {
    for (const context of [bootstrap, repair]) {
      for (const kind of ['evicted', 'timeout', 'agent'] as const) {
        const key = presentFailure({ kind, reason: null }, context).causeKey
        expect(key, `${context.runKind} ${kind}`).toBe(`board.failure.cause.singleJob.${kind}`)
      }
    }
    // A kind that reads the same for every run keeps the shared line.
    expect(presentFailure({ kind: 'dispatch', reason: null }, bootstrap).causeKey).toBe(
      FAILURE_CAUSE_KEYS.dispatch,
    )
  })

  it('offers Retry and no setting for every kind that neither fixes', () => {
    const special = new Set(['environment', 'state_unreadable'])
    for (const kind of AGENT_FAILURE_KINDS.filter((k) => !special.has(k))) {
      const presented = presentFailure({ kind, reason: null }, task)
      expect(presented.action, kind).toBe('retry')
      expect(presented.fix, kind).toBeNull()
    }
  })

  it('starts a new run when a task run state cannot be read, because a retry reads it again', () => {
    expect(presentFailure({ kind: 'state_unreadable', reason: null }, task).action).toBe('newRun')
  })

  describe('a refusal reason', () => {
    it('reads the copy and the fix of every mapped conflict from the table the toast reads', () => {
      // The whole class, not one special case: every conflict a run can hit before it starts.
      for (const reason of Object.keys(CONFLICT_INFO) as (keyof typeof CONFLICT_INFO)[]) {
        const info = CONFLICT_INFO[reason]
        const presented = presentFailure({ kind: 'preflight', reason }, task)
        expect(presented.titleKey, reason).toBe(info.titleKey)
        expect(presented.causeKey, reason).toBe(info.descriptionKey)
        expect(presented.action, reason).toBe(info.action ? 'fix' : 'retry')
        expect(presented.fix, reason).toBe(info.action ?? null)
      }
    })

    it('opens the fix for a bespoke reason a settings panel fixes, with a line that exists', () => {
      for (const reason of Object.keys(
        BESPOKE_CONFLICT_FIXES,
      ) as (keyof typeof BESPOKE_CONFLICT_FIXES)[]) {
        const presented = presentFailure({ kind: 'preflight', reason }, task)
        expect(presented.action, reason).toBe('fix')
        expect(presented.fix, reason).toBe(BESPOKE_CONFLICT_FIXES[reason].action)
        expect(typeof message(presented.causeKey), reason).toBe('string')
      }
    })

    it('connects a repository host whatever the kind, because a retry fails until it is', () => {
      for (const kind of ['preflight', 'agent', 'unknown'] as const) {
        const presented = presentFailure({ kind, reason: 'github_not_connected' }, task)
        expect(presented.action, kind).toBe('fix')
        expect(presented.fix, kind).toBe(CONFLICT_INFO.github_not_connected.action)
      }
    })

    it('treats a reason that is not a conflict by its kind', () => {
      expect(CONFLICT_REASONS).not.toContain('a_reason_from_elsewhere')
      const presented = presentFailure(
        { kind: 'preflight', reason: 'a_reason_from_elsewhere' },
        task,
      )
      expect(presented.causeKey).toBe(FAILURE_CAUSE_KEYS.preflight)
      expect(presented.titleKey).toBeNull()
    })
  })

  describe('an environment failure', () => {
    it('leads with Retry and offers the environment settings beside it', () => {
      // Most often a temporary provider fault, so the remedy that usually works stays first.
      const presented = presentFailure({ kind: 'environment', reason: null }, task)
      expect(presented.action).toBe('retry')
      expect(presented.fix?.labelKey).toBe('board.failure.environmentSetup')
    })

    it('opens the runner pool when no deploy runner is wired on a hosted deployment', () => {
      const presented = presentFailure(
        { kind: 'environment', reason: 'deploy_runner_unwired' },
        task,
      )
      expect(presented.action).toBe('fix')
      expect(presented.fix?.labelKey).toBe('board.failure.deployRunnerSetup')
    })

    it('names the .env variable on a local node, with Retry and no settings tab', () => {
      const failure = { kind: 'environment', reason: 'deploy_runner_unwired' } as const
      expect(isLocalDeployRunnerUnwired(failure, local)).toBe(true)
      expect(isLocalDeployRunnerUnwired(failure, task)).toBe(false)
      const presented = presentFailure(failure, local)
      expect(presented).toMatchObject({
        causeKey: 'board.failure.cause.deployRunnerUnwiredLocal',
        causeParams: { variable: 'LOCAL_DEPLOY_RUNTIME' },
        action: 'retry',
        fix: null,
      })
      expect(message(presented.causeKey)).toContain('{variable}')
    })
  })
})

describe('failureOutput', () => {
  it('shows a detail once: not when it is absent, and not when it repeats the message', () => {
    expect(failureOutput({ message: 'm', detail: 'exit code 137' })).toBe('exit code 137')
    expect(failureOutput({ message: 'm', detail: null })).toBeNull()
    expect(failureOutput({ message: 'same', detail: 'same' })).toBeNull()
  })
})
