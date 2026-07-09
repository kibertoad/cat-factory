import { describe, expect, it, vi } from 'vitest'
import { decideHarnessVersion, parseImageVersion, verifyHarnessVersion } from './harnessVersion.js'

describe('parseImageVersion', () => {
  it('extracts a concrete version tag', () => {
    expect(parseImageVersion('ghcr.io/kibertoad/cat-factory-executor:1.40.0')).toBe('1.40.0')
    expect(parseImageVersion('cat-factory-executor:0.6.0-rc1')).toBe('0.6.0-rc1')
  })

  it('ignores non-version tags and digest/no-tag refs', () => {
    expect(parseImageVersion('ghcr.io/o/cat-factory-executor:latest')).toBeUndefined()
    expect(parseImageVersion('ghcr.io/o/cat-factory-executor:main')).toBeUndefined()
    expect(parseImageVersion('ghcr.io/o/cat-factory-executor')).toBeUndefined()
    expect(parseImageVersion('ghcr.io/o/cat-factory-executor@sha256:abc123def456')).toBeUndefined()
  })

  it('does not mistake a registry port for a tag', () => {
    // `localhost:5000/img` has a colon BEFORE the last slash — not a tag.
    expect(parseImageVersion('localhost:5000/cat-factory-executor')).toBeUndefined()
    expect(parseImageVersion('localhost:5000/cat-factory-executor:1.2.3')).toBe('1.2.3')
  })
})

describe('decideHarnessVersion', () => {
  const source = { ref: 'ghcr.io/o/cat-factory-executor:1.40.0', kind: 'image' as const }

  it('passes when the reported version matches', () => {
    expect(
      decideHarnessVersion({ reported: '1.40.0', expected: '1.40.0', custom: false, source }),
    ).toEqual({ level: 'ok' })
  })

  it('skips when there is no matched version to check against', () => {
    expect(
      decideHarnessVersion({ reported: '1.39.1', expected: undefined, custom: false, source })
        .level,
    ).toBe('skip')
  })

  it('FAILS loudly on a stock deployment mismatch', () => {
    const d = decideHarnessVersion({
      reported: '1.37.0',
      expected: '1.40.0',
      custom: false,
      source,
    })
    expect(d.level).toBe('fail')
    expect(d.level === 'fail' && d.message).toContain('1.40.0')
    expect(d.level === 'fail' && d.message).toContain('1.37.0')
    expect(d.level === 'fail' && d.message).toContain('docker pull')
  })

  it('FAILS when the harness reports NO version (predates the handshake ⇒ stale)', () => {
    const d = decideHarnessVersion({
      reported: undefined,
      expected: '1.40.0',
      custom: false,
      source,
    })
    expect(d.level).toBe('fail')
    expect(d.level === 'fail' && d.message).toContain('did not report a version')
  })

  it('downgrades a mismatch to a WARNING when a custom harness is pinned', () => {
    const d = decideHarnessVersion({
      reported: '1.37.0',
      expected: '1.40.0',
      custom: true,
      source: { ref: '/path/to/dist/server.js', kind: 'native' },
    })
    expect(d.level).toBe('warn')
    expect(d.level === 'warn' && d.message).toContain('custom harness override')
  })

  it('gives native-specific remediation for the native source', () => {
    const d = decideHarnessVersion({
      reported: undefined,
      expected: '1.40.0',
      custom: false,
      source: { ref: '/path/to/dist/server.js', kind: 'native' },
    })
    expect(d.level === 'fail' && d.message).toContain('@cat-factory/executor-harness')
  })
})

describe('verifyHarnessVersion', () => {
  const endpoint = { host: '127.0.0.1', port: 8080 }
  const source = { ref: 'ghcr.io/o/cat-factory-executor:1.40.0', kind: 'image' as const }

  const health = (body: unknown): typeof fetch =>
    (async () =>
      ({ ok: true, json: async () => body }) as unknown as Response) as unknown as typeof fetch

  const base = { endpoint, secret: 's', requestTimeoutMs: 1_000, custom: false, source }

  it('is a no-op when there is no expected version (does not even probe)', async () => {
    const fetchImpl = vi.fn()
    await verifyHarnessVersion({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      expected: undefined,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves silently when the reported version matches', async () => {
    const onWarn = vi.fn()
    await expect(
      verifyHarnessVersion({
        ...base,
        fetchImpl: health({ status: 'ok', version: '1.40.0' }),
        expected: '1.40.0',
        onWarn,
      }),
    ).resolves.toBeUndefined()
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('THROWS a loud, actionable error on a stock mismatch', async () => {
    await expect(
      verifyHarnessVersion({
        ...base,
        fetchImpl: health({ status: 'ok', version: '1.37.0' }),
        expected: '1.40.0',
      }),
    ).rejects.toThrow(/version mismatch.*1\.40\.0.*1\.37\.0/s)
  })

  it('THROWS when the harness reports no version at all (predates the handshake)', async () => {
    await expect(
      verifyHarnessVersion({
        ...base,
        fetchImpl: health({ status: 'ok' }),
        expected: '1.40.0',
      }),
    ).rejects.toThrow(/did not report a version/)
  })

  it('calls onWarn (does NOT throw) on a mismatch under a custom override', async () => {
    const onWarn = vi.fn()
    await expect(
      verifyHarnessVersion({
        ...base,
        custom: true,
        fetchImpl: health({ status: 'ok', version: '1.37.0' }),
        expected: '1.40.0',
        onWarn,
      }),
    ).resolves.toBeUndefined()
    expect(onWarn).toHaveBeenCalledOnce()
    expect(onWarn.mock.calls[0]?.[0]).toContain('custom harness override')
  })
})
