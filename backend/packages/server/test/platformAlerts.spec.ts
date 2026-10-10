import { MAX_FAILURE_KIND_LENGTH, MAX_FAILURE_KIND_RULES } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  parseFailureKindRules,
  parsePlatformObservabilityWindow,
  resolvePlatformAlertConfig,
} from '../src/config/platformAlerts.js'

describe('parsePlatformObservabilityWindow', () => {
  it('accepts the known windows and defaults everything else to 1h', () => {
    expect(parsePlatformObservabilityWindow('24h')).toBe('24h')
    expect(parsePlatformObservabilityWindow('7d')).toBe('7d')
    expect(parsePlatformObservabilityWindow('1h')).toBe('1h')
    expect(parsePlatformObservabilityWindow(undefined)).toBe('1h')
    expect(parsePlatformObservabilityWindow('nonsense')).toBe('1h')
  })
})

describe('resolvePlatformAlertConfig', () => {
  it('uses the built-in defaults when only the enable flag is set', () => {
    const cfg = resolvePlatformAlertConfig({ enabled: true })
    expect(cfg.enabled).toBe(true)
    expect(cfg.window).toBe('1h')
    expect(cfg.intervalMs).toBe(5 * 60_000)
    expect(cfg.thresholds).toEqual({
      minRuns: 5,
      maxFailureRate: 0.5,
      maxP99DurationMs: 60 * 60_000,
      maxBacklog: 50,
      stalledBuckets: 3,
      minStalledPriorRuns: 5,
      maxFailureKindShare: 0.8,
      maxSweepFailures: 3,
      // No per-kind rules unless an operator names them: which kinds deserve their own ceiling
      // is a judgement about a deployment, and a shipped default would page on that guess.
      failureKindRules: [],
    })
  })

  it('parses overrides, converting p99 minutes to ms', () => {
    const cfg = resolvePlatformAlertConfig({
      enabled: true,
      window: '24h',
      intervalMs: '120000',
      minRuns: '10',
      maxFailureRate: '0.25',
      maxP99Minutes: '30',
      maxBacklog: '100',
    })
    expect(cfg.window).toBe('24h')
    expect(cfg.intervalMs).toBe(120_000)
    expect(cfg.thresholds).toEqual({
      minRuns: 10,
      maxFailureRate: 0.25,
      maxP99DurationMs: 30 * 60_000,
      maxBacklog: 100,
      // Unset in this override bag, so each falls back to its built-in default.
      stalledBuckets: 3,
      minStalledPriorRuns: 5,
      maxFailureKindShare: 0.8,
      maxSweepFailures: 3,
      failureKindRules: [],
    })
  })

  it('clamps out-of-range values (failure rate ≤ 1, interval floored, min counts ≥ 1)', () => {
    const cfg = resolvePlatformAlertConfig({
      enabled: false,
      intervalMs: '0',
      minRuns: '0',
      maxFailureRate: '5',
      maxBacklog: '0',
    })
    expect(cfg.enabled).toBe(false)
    expect(cfg.intervalMs).toBe(10_000) // floored, no busy-loop
    expect(cfg.thresholds.maxFailureRate).toBe(1)
    expect(cfg.thresholds.minRuns).toBe(1)
    expect(cfg.thresholds.maxBacklog).toBe(1)
  })

  it('falls back to defaults on negative or garbage numeric overrides', () => {
    const cfg = resolvePlatformAlertConfig({
      enabled: true,
      minRuns: '-3',
      maxFailureRate: 'abc',
      maxP99Minutes: '',
    })
    expect(cfg.thresholds.minRuns).toBe(5)
    expect(cfg.thresholds.maxFailureRate).toBe(0.5)
    expect(cfg.thresholds.maxP99DurationMs).toBe(60 * 60_000)
  })
})

describe('parseFailureKindRules', () => {
  it('reads `kind=share[:minCount]`, comma-separated', () => {
    expect(parseFailureKindRules('evicted=0.05:3, timeout=0.2')).toEqual([
      { kind: 'evicted', maxShare: 0.05, minCount: 3 },
      // No `minCount` written where none was given: the rule is edited beside settings-authored
      // ones, where an unset minimum reads as inherited rather than as a typed 1.
      { kind: 'timeout', maxShare: 0.2 },
    ])
  })

  it('is empty when unset or blank, which is the same as having no rules', () => {
    expect(parseFailureKindRules(undefined)).toEqual([])
    expect(parseFailureKindRules('  ')).toEqual([])
  })

  it('drops only the entry it cannot read, keeping the ones it can', () => {
    // The operator who typed one rule wrongly keeps the rules they typed correctly, and hears
    // about the one that was dropped (each rejection logs). Taking the value as a whole would
    // silently disarm a pager they believe is armed.
    expect(parseFailureKindRules('evicted, timeout=0.2, agent=abc, =0.5, dispatch=0')).toEqual([
      { kind: 'timeout', maxShare: 0.2 },
    ])
  })

  it('refuses a share outside (0, 1] rather than clamping it into range', () => {
    // Clamping `evicted=50` to 1.0 would invent "when EVERY failure is an eviction" out of
    // somebody who meant 50%, and arm it.
    expect(parseFailureKindRules('evicted=50')).toEqual([])
    expect(parseFailureKindRules('evicted=-0.1')).toEqual([])
    expect(parseFailureKindRules('evicted=1')).toEqual([{ kind: 'evicted', maxShare: 1 }])
  })

  it('refuses a minimum count that is not a whole number of 1 or more', () => {
    expect(parseFailureKindRules('evicted=0.1:0')).toEqual([])
    expect(parseFailureKindRules('evicted=0.1:1.5')).toEqual([])
    expect(parseFailureKindRules('evicted=0.1:2')).toEqual([
      { kind: 'evicted', maxShare: 0.1, minCount: 2 },
    ])
  })

  it('keeps the first rule for a kind and reports the repeat', () => {
    expect(parseFailureKindRules('evicted=0.1,evicted=0.9')).toEqual([
      { kind: 'evicted', maxShare: 0.1 },
    ])
  })

  it('KEEPS a rule naming an unrecognised kind, which is reported rather than dropped', () => {
    // A typo and a retired kind are the same string here, and nothing can tell them apart, so
    // the rule survives for a human to decide about (as in the settings editor) while the fact
    // that it can never fire is logged. Dropping it silently and keeping it silently are both
    // the same failure: a pager somebody armed that reads exactly like a kind that never
    // occurred, discovered on the night it did not go off.
    expect(parseFailureKindRules('evicetd=0.05, evicted=0.1')).toEqual([
      { kind: 'evicetd', maxShare: 0.05 },
      { kind: 'evicted', maxShare: 0.1 },
    ])
  })

  it('refuses a kind longer than the contract allows, like a settings-authored rule', () => {
    // Env-derived rules never pass through `platformFailureKindRuleSchema`, so this bound has
    // to be restated here or the deployment default and the account override stop meaning the
    // same thing.
    const tooLong = 'k'.repeat(MAX_FAILURE_KIND_LENGTH + 1)
    expect(parseFailureKindRules(`${tooLong}=0.5, evicted=0.1`)).toEqual([
      { kind: 'evicted', maxShare: 0.1 },
    ])
    const atLimit = 'k'.repeat(MAX_FAILURE_KIND_LENGTH)
    expect(parseFailureKindRules(`${atLimit}=0.5`)).toEqual([{ kind: atLimit, maxShare: 0.5 }])
  })

  it('stops at the contract cap rather than building a list a save would refuse', () => {
    const entries = Array.from(
      { length: MAX_FAILURE_KIND_RULES + 3 },
      (_, i) => `kind${i}=0.5`,
    ).join(',')
    const rules = parseFailureKindRules(entries)
    expect(rules).toHaveLength(MAX_FAILURE_KIND_RULES)
    // The kept ones are the FIRST, matching how a repeated kind resolves: earlier wins, and the
    // dropped tail is reported per entry rather than silently truncated.
    expect(rules[0]).toEqual({ kind: 'kind0', maxShare: 0.5 })
  })

  it('reaches the resolved thresholds', () => {
    const cfg = resolvePlatformAlertConfig({ enabled: true, failureKindRates: 'evicted=0.05' })
    expect(cfg.thresholds.failureKindRules).toEqual([{ kind: 'evicted', maxShare: 0.05 }])
  })
})
