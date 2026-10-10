import { describe, expect, it } from 'vitest'
import { type ExecutionInstance, executionStatusSchema } from '@cat-factory/contracts'
import {
  decodeCursor,
  decodeTimeCursor,
  encodeCursor,
  internalStatusesFor,
  jobSortKey,
} from './publicApiPaging.js'

// The keyset-cursor codec behind the public `/api/v1` list endpoints. It is the piece that makes
// a paged external read safe to poll, so its edge cases are pinned here rather than only through
// the (slower, store-level) conformance suite.
describe('publicApiPaging', () => {
  describe('cursor codec', () => {
    it('round-trips a numeric sort key and its id', () => {
      const encoded = encodeCursor(1_700_000_000_123, 'task_abc123')
      expect(decodeTimeCursor(encoded)).toEqual({ createdAt: 1_700_000_000_123, id: 'task_abc123' })
    })

    it('round-trips a string sort key', () => {
      expect(decodeCursor(encodeCursor('blk_zzz', 'blk_zzz'))).toEqual({
        sortKey: 'blk_zzz',
        id: 'blk_zzz',
      })
    })

    it('is opaque on the wire (url-safe, no base64 padding or +/ characters)', () => {
      // The cursor travels in a query string, so it must survive without escaping — a raw `+`
      // would decode as a space and silently corrupt the position.
      const encoded = encodeCursor(1_700_000_000_000, 'task_ffffffffffff')
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(encodeURIComponent(encoded)).toBe(encoded)
    })

    it('splits on the FIRST separator so an id containing one survives', () => {
      // Ids are `<prefix>_<hex>` today, but the codec must not corrupt one that ever gains a `|`.
      expect(decodeCursor(encodeCursor('1', 'weird|id'))).toEqual({ sortKey: '1', id: 'weird|id' })
    })

    it('rejects malformed input rather than guessing a position', () => {
      // Each of these must be a clean null so the route answers 400 — a codec that fell back to
      // "start from the beginning" would loop a paging client over page 1 forever, with no error.
      expect(decodeCursor('!!!not-base64!!!')).toBeNull()
      expect(decodeCursor(encodeCursor('', 'id'))).toBeNull() // empty sort key
      expect(decodeCursor(btoa('no-separator'))).toBeNull()
      expect(decodeCursor(btoa('sortkey|'))).toBeNull() // empty id
    })

    it('rejects a time cursor whose sort key is not a plain epoch-ms integer', () => {
      // `Number()` alone would read every one of these as a plausible position (0, 1000, 16, -5)
      // and resume paging from somewhere the query never ordered by, instead of 400-ing.
      for (const sortKey of ['not-a-number', ' ', '1e3', '0x10', '-5', '1.5', '']) {
        expect(decodeTimeCursor(encodeCursor(sortKey, 'exec_1'))).toBeNull()
      }
      expect(decodeTimeCursor(encodeCursor(1_700_000_000_123, 'exec_1'))).toEqual({
        createdAt: 1_700_000_000_123,
        id: 'exec_1',
      })
    })
  })

  describe('internalStatusesFor', () => {
    it('expands the coarse `running` filter to every status that reads as running externally', () => {
      // The inverse of the controller's `mapStatus`: a parked (`blocked`) or spend-gated
      // (`paused`) run is reported as `running` to an external caller, so filtering on the
      // literal `running` row value would hide exactly the jobs a caller polls for.
      expect(new Set(internalStatusesFor('running'))).toEqual(
        new Set(['running', 'blocked', 'paused']),
      )
    })

    it('maps the terminal statuses one-to-one', () => {
      expect(internalStatusesFor('succeeded')).toEqual(['done'])
      expect(internalStatusesFor('failed')).toEqual(['failed'])
    })

    it('covers EVERY execution status across the three coarse filters', () => {
      // The expansion is derived from `mapStatus` over the full union, so this holds by
      // construction — the assertion is here to fail loudly if that derivation is ever replaced
      // by a hand-written list that a new `ExecutionStatus` member could fall out of.
      const covered = (['running', 'succeeded', 'failed'] as const).flatMap(internalStatusesFor)
      expect(new Set(covered)).toEqual(new Set(executionStatusSchema.options))
      expect(covered.length).toBe(executionStatusSchema.options.length) // no status in two buckets
    })
  })

  describe('jobSortKey', () => {
    it('is the run creation stamp, which the mapper projects from the row column', () => {
      expect(jobSortKey({ createdAt: 1_700_000_000_123 } as ExecutionInstance)).toBe(
        1_700_000_000_123,
      )
    })

    it('falls back to 0 only for a run that was never persisted', () => {
      expect(jobSortKey({} as ExecutionInstance)).toBe(0)
    })
  })
})
