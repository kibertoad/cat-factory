import { describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import { AGENT_FAILURE_KINDS } from '~/utils/failureKinds'
import { FAILURE_CAUSE_KEYS, presentFailure } from '~/utils/failureCause'

/** The `en` message at a dotted key, or undefined when the key does not exist. */
function message(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
  }, en)
}

describe('presentFailure', () => {
  it('gives every failure kind a cause line that exists in the catalog', () => {
    // The relation, not a count: each kind the contract declares resolves to a real `en` string,
    // so a kind added later fails here by name if its line is missing.
    for (const kind of AGENT_FAILURE_KINDS) {
      const { causeKey } = presentFailure({ kind, reason: null }, { localMode: false })
      expect(causeKey).toBe(FAILURE_CAUSE_KEYS[kind])
      expect(typeof message(causeKey), kind).toBe('string')
    }
  })

  it('offers Retry for every kind that a setting does not fix', () => {
    for (const kind of AGENT_FAILURE_KINDS.filter((k) => k !== 'environment')) {
      expect(presentFailure({ kind, reason: null }, { localMode: false }).action, kind).toBe(
        'retry',
      )
    }
  })

  it('opens the repository-host connection when no host is connected, whatever the kind', () => {
    // A retry fails again until the host is connected, so Retry is not the action here.
    const presented = presentFailure(
      { kind: 'preflight', reason: 'github_not_connected' },
      { localMode: false },
    )
    expect(presented).toEqual({
      causeKey: 'errors.conflict.description.github_not_connected',
      action: 'connectRepoHost',
    })
    expect(typeof message(presented.causeKey)).toBe('string')
  })

  it('sends an unwired deploy runner to the runner-pool tab, but not on a local node', () => {
    const failure = { kind: 'environment', reason: 'deploy_runner_unwired' } as const
    expect(presentFailure(failure, { localMode: false }).action).toBe('runnerPoolSetup')
    // On a local node the fix is an environment variable, which Details names.
    expect(presentFailure(failure, { localMode: true }).action).toBe('environmentSetup')
  })

  it('sends every other environment failure to the environment tab', () => {
    expect(presentFailure({ kind: 'environment', reason: null }, { localMode: false }).action).toBe(
      'environmentSetup',
    )
  })
})
