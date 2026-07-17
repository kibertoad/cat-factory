import { describe, expect, it } from 'vitest'
import {
  PLATFORM_METRICS_DEFAULT_INTERVAL_MS,
  parsePlatformMetricsIntervalMs,
  parsePlatformMetricsWindow,
} from './index.js'

describe('parsePlatformMetricsIntervalMs', () => {
  it('parses a positive integer', () => {
    expect(parsePlatformMetricsIntervalMs('30000')).toBe(30_000)
  })

  it('floors a fractional value', () => {
    expect(parsePlatformMetricsIntervalMs('1500.9')).toBe(1_500)
  })

  it('falls back to the default for unset / non-numeric / non-positive', () => {
    expect(parsePlatformMetricsIntervalMs(undefined)).toBe(PLATFORM_METRICS_DEFAULT_INTERVAL_MS)
    expect(parsePlatformMetricsIntervalMs('')).toBe(PLATFORM_METRICS_DEFAULT_INTERVAL_MS)
    expect(parsePlatformMetricsIntervalMs('abc')).toBe(PLATFORM_METRICS_DEFAULT_INTERVAL_MS)
    expect(parsePlatformMetricsIntervalMs('0')).toBe(PLATFORM_METRICS_DEFAULT_INTERVAL_MS)
    expect(parsePlatformMetricsIntervalMs('-5')).toBe(PLATFORM_METRICS_DEFAULT_INTERVAL_MS)
  })
})

describe('parsePlatformMetricsWindow', () => {
  it('accepts the valid windows', () => {
    expect(parsePlatformMetricsWindow('1h')).toBe('1h')
    expect(parsePlatformMetricsWindow('24h')).toBe('24h')
    expect(parsePlatformMetricsWindow('7d')).toBe('7d')
    expect(parsePlatformMetricsWindow(' 24h ')).toBe('24h')
  })

  it('defaults to 1h for anything else', () => {
    expect(parsePlatformMetricsWindow(undefined)).toBe('1h')
    expect(parsePlatformMetricsWindow('')).toBe('1h')
    expect(parsePlatformMetricsWindow('30d')).toBe('1h')
  })
})
