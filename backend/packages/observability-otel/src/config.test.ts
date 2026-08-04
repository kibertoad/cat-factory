import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOG_BATCH_SIZE,
  LOG_EXPORT_DEFAULT_FLUSH_INTERVAL_MS,
  PLATFORM_METRICS_DEFAULT_INTERVAL_MS,
  parseLogExportBatchSize,
  parseLogExportFlushIntervalMs,
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

describe('parseLogExportFlushIntervalMs', () => {
  it('parses a positive integer', () => {
    expect(parseLogExportFlushIntervalMs('2000')).toBe(2_000)
  })

  it('falls back to the default for unset / non-numeric / non-positive', () => {
    expect(parseLogExportFlushIntervalMs(undefined)).toBe(LOG_EXPORT_DEFAULT_FLUSH_INTERVAL_MS)
    expect(parseLogExportFlushIntervalMs('soon')).toBe(LOG_EXPORT_DEFAULT_FLUSH_INTERVAL_MS)
    expect(parseLogExportFlushIntervalMs('0')).toBe(LOG_EXPORT_DEFAULT_FLUSH_INTERVAL_MS)
    expect(parseLogExportFlushIntervalMs('-5')).toBe(LOG_EXPORT_DEFAULT_FLUSH_INTERVAL_MS)
  })
})

describe('parseLogExportBatchSize', () => {
  it('parses a positive integer', () => {
    expect(parseLogExportBatchSize('32')).toBe(32)
  })

  it('falls back to the default for unset / non-numeric / non-positive', () => {
    expect(parseLogExportBatchSize(undefined)).toBe(DEFAULT_LOG_BATCH_SIZE)
    expect(parseLogExportBatchSize('lots')).toBe(DEFAULT_LOG_BATCH_SIZE)
    expect(parseLogExportBatchSize('0')).toBe(DEFAULT_LOG_BATCH_SIZE)
  })
})
