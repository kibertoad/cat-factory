import { describe, expect, it } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import { createUserScopedLoad } from '~/stores/userScopedLoad'

// The load rule the three user-scoped stores share. `loadFailed` must tell "nothing to show"
// from "did not load", in both directions, and only the newest of two overlapping calls may
// settle it.

const moduleOff = () =>
  new ApiError(503, { error: { code: 'unavailable', message: 'X is not configured' } })

/** A load whose `fetch` answers from a queue the test controls. */
function harness() {
  const answers: Array<() => Promise<string[]>> = []
  const list: { value: string[] } = { value: ['stale'] }
  const loader = createUserScopedLoad({
    fetch: () => (answers.shift() as () => Promise<string[]>)(),
    apply: (value) => (list.value = value),
    reset: () => (list.value = []),
  })
  return { answers, list, ...loader }
}

describe('createUserScopedLoad', () => {
  it.each([
    ['a 401', () => new ApiError(401, {})],
    ['a module-off 503', moduleOff],
  ])('clears an earlier failure on %s, which means nothing to show', async (_label, refusal) => {
    const h = harness()
    h.answers.push(() => Promise.reject(new ApiError(500, {})))
    await h.load()
    expect(h.loadFailed.value).toBe(true)
    h.answers.push(() => Promise.reject(refusal()))
    await h.load()
    expect(h.loadFailed.value).toBe(false)
    expect(h.list.value).toEqual([])
  })

  it.each([
    ['a 500', () => new ApiError(500, {})],
    ['an outage 503 with no envelope', () => new ApiError(503, 'Service Unavailable')],
    ['a network error', () => new TypeError('Failed to fetch')],
  ])('records %s as a failed load', async (_label, error) => {
    const h = harness()
    h.answers.push(() => Promise.reject(error()))
    await h.load()
    expect(h.loadFailed.value).toBe(true)
    expect(h.list.value).toEqual([])
  })

  it('clears the failure once a later load succeeds', async () => {
    const h = harness()
    h.answers.push(() => Promise.reject(new ApiError(500, {})))
    await h.load()
    h.answers.push(() => Promise.resolve(['token']))
    await h.load()
    expect(h.loadFailed.value).toBe(false)
    expect(h.list.value).toEqual(['token'])
  })

  it('lets only the newest of two overlapping loads settle the state', async () => {
    const h = harness()
    let failFirst: (error: unknown) => void = () => {}
    h.answers.push(() => new Promise((_resolve, reject) => (failFirst = reject)))
    h.answers.push(() => Promise.resolve(['token']))
    const first = h.load()
    const second = h.load()
    expect(h.loading.value).toBe(true)
    await second
    expect(h.loading.value).toBe(false)
    // The older call fails after the newer one succeeded: it must not undo that answer.
    failFirst(new ApiError(500, {}))
    await first
    expect(h.loadFailed.value).toBe(false)
    expect(h.list.value).toEqual(['token'])
    expect(h.loading.value).toBe(false)
  })
})
