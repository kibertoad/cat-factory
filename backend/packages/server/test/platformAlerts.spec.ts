import { describe, expect, it } from 'vitest'
import {
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
