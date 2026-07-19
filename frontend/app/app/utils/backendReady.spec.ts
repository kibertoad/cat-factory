import { SchemaValidationError } from '@toad-contracts/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import { isBackendUnreachable, retryWhileBackendUnreachable } from '~/utils/backendReady'

// The cold-start race: the SPA's first fetch can beat the backend's listener, throwing a
// status-less network fault. These lock in that we wait THAT out (with a deadline) but
// surface a real HTTP error response — a live-but-erroring backend — immediately.

describe('isBackendUnreachable', () => {
  it('is true for a status-less network fault', () => {
    expect(isBackendUnreachable(new Error('Failed to fetch'))).toBe(true)
  })

  it('is false for an HTTP error response (the backend answered)', () => {
    expect(isBackendUnreachable(new ApiError(500, {}))).toBe(false)
    expect(isBackendUnreachable({ status: 503 })).toBe(false)
  })

  it('is false for a schema-validation failure (a deterministic answer, not a dead socket)', () => {
    // The backend answered but its body (or our request) didn't match the contract — retrying
    // can never clear it, so it must surface at once rather than wait out the deadline.
    expect(isBackendUnreachable(new SchemaValidationError([]))).toBe(false)
  })
})

describe('retryWhileBackendUnreachable', () => {
  afterEach(() => vi.useRealTimers())

  it('returns the first result without waiting when the backend answers', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(retryWhileBackendUnreachable(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a not-listening-yet backend, then succeeds', async () => {
    vi.useFakeTimers()
    let calls = 0
    const fn = vi.fn(async () => {
      if (++calls < 3) throw new Error('connection refused') // status-less
      return 'ok'
    })
    const promise = retryWhileBackendUnreachable(fn)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(promise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('rethrows an HTTP error response immediately (no retry)', async () => {
    const fn = vi.fn(async () => {
      throw new ApiError(500, {})
    })
    await expect(retryWhileBackendUnreachable(fn)).rejects.toBeInstanceOf(ApiError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up and rethrows the last fault once the deadline passes', async () => {
    vi.useFakeTimers()
    const fn = vi.fn(async () => {
      throw new Error('down')
    })
    const rejects = expect(retryWhileBackendUnreachable(fn, { deadlineMs: 1_000 })).rejects.toThrow(
      'down',
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await rejects
    expect(fn.mock.calls.length).toBeGreaterThan(1)
  })
})
