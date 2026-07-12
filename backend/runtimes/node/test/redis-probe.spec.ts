import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REDIS_PROBE_TIMEOUT_MS,
  describeRedisUnreachable,
  probeRedisReachable,
  redisTargetLabel,
  warnIfRedisUnreachable,
} from '../src/redisProbe.js'

// The boot-time Redis reachability probe (error-message coverage A7). Pure helpers + the probe
// orchestrator are exercised with an injected connect probe, so no Redis server is needed. This
// covers the SILENT-degradation failure mode: REDIS_URL set but the bus unreachable, which must
// surface as ONE elaborate boot warning naming the host + how to verify (the missing-ioredis FATAL
// case is covered by missingIoredisProblem in the server package's misconfigured spec).

function collectWarnings() {
  const warnings: { obj: object; msg?: string }[] = []
  return {
    log: { info: () => {}, warn: (obj: object, msg?: string) => warnings.push({ obj, msg }) },
    warnings,
  }
}

describe('redisTargetLabel', () => {
  it('renders host:port and never leaks credentials', () => {
    expect(redisTargetLabel('redis://localhost:6379')).toBe('localhost:6379')
    expect(redisTargetLabel('redis://cache.internal:6380/0')).toBe('cache.internal:6380')
    // A password in the userinfo must not survive into the label.
    const labelled = redisTargetLabel('redis://:sup3rsecret@cache.internal:6379')
    expect(labelled).toBe('cache.internal:6379')
    expect(labelled).not.toContain('sup3rsecret')
  })

  it('falls back to a generic phrase for an unparseable url', () => {
    expect(redisTargetLabel('not a url')).toBe('the configured Redis host')
  })
})

describe('describeRedisUnreachable', () => {
  it('names the host, the degradation, how to verify, and links the docs — without the password', () => {
    const msg = describeRedisUnreachable('redis://:sup3rsecret@cache.internal:6379', 3000)
    expect(msg).toContain('cache.internal:6379')
    expect(msg).not.toContain('sup3rsecret')
    expect(msg).toMatch(/DEGRADED/)
    expect(msg).toMatch(/redis-cli -u <REDIS_URL> ping/)
    expect(msg).toMatch(/within 3000ms/)
    expect(msg).toMatch(/concurrency-and-redis\.md/)
  })
})

describe('probeRedisReachable', () => {
  it('returns true when the bus answers', async () => {
    expect(await probeRedisReachable('redis://fake', { connectProbe: async () => true })).toBe(true)
  })

  it('returns false when the bus does not answer', async () => {
    expect(await probeRedisReachable('redis://fake', { connectProbe: async () => false })).toBe(
      false,
    )
  })

  it('passes the configured timeout through to the probe', async () => {
    let seen = -1
    await probeRedisReachable('redis://fake', {
      timeoutMs: 1234,
      connectProbe: async (_url, timeoutMs) => {
        seen = timeoutMs
        return true
      },
    })
    expect(seen).toBe(1234)
  })

  it('treats a probe that throws as unreachable (never propagates)', async () => {
    expect(
      await probeRedisReachable('redis://fake', {
        connectProbe: async () => {
          throw new Error('kaboom')
        },
      }),
    ).toBe(false)
  })

  it('returns undefined when the probe cannot run (ioredis absent)', async () => {
    expect(await probeRedisReachable('redis://fake', { connectProbe: async () => undefined })).toBe(
      undefined,
    )
  })
})

describe('warnIfRedisUnreachable', () => {
  it('is a no-op when REDIS_URL is unset (single-node / local mode)', async () => {
    const { log, warnings } = collectWarnings()
    await warnIfRedisUnreachable({}, log, { connectProbe: async () => false })
    expect(warnings).toEqual([])
  })

  it('warns once, naming the host, when the bus is set but unreachable', async () => {
    const { log, warnings } = collectWarnings()
    await warnIfRedisUnreachable({ REDIS_URL: 'redis://cache.internal:6379' }, log, {
      connectProbe: async () => false,
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.obj).toEqual({ target: 'cache.internal:6379' })
    expect(warnings[0]!.msg).toMatch(/cache\.internal:6379/)
    expect(warnings[0]!.msg).toMatch(/DEGRADED/)
  })

  it('stays silent when the bus is reachable', async () => {
    const { log, warnings } = collectWarnings()
    await warnIfRedisUnreachable({ REDIS_URL: 'redis://cache.internal:6379' }, log, {
      connectProbe: async () => true,
    })
    expect(warnings).toEqual([])
  })

  it('stays silent when the probe could not run (ioredis absent — the fatal path covers it)', async () => {
    const { log, warnings } = collectWarnings()
    await warnIfRedisUnreachable({ REDIS_URL: 'redis://cache.internal:6379' }, log, {
      connectProbe: async () => undefined,
    })
    expect(warnings).toEqual([])
  })

  it('exposes a sane default timeout', () => {
    expect(DEFAULT_REDIS_PROBE_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
