import { blockStatusSchema } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  DataIntegrityError,
  decodeEnum,
  decodeEnumOr,
  decodeJson,
  tryDecodeRow,
  tryDecodeRows,
} from '../src/persistence/decode.js'

const ctx = { table: 'blocks', column: 'status', id: 'blk_1' }

describe('decodeEnum', () => {
  it('returns a known enum member unchanged', () => {
    expect(decodeEnum(blockStatusSchema, 'done', ctx)).toBe('done')
  })

  it('throws a DataIntegrityError on an unknown value', () => {
    expect(() => decodeEnum(blockStatusSchema, 'not_a_status', ctx)).toThrow(DataIntegrityError)
  })

  it('carries the row context on the error', () => {
    try {
      decodeEnum(blockStatusSchema, 'bogus', ctx)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(DataIntegrityError)
      expect((err as DataIntegrityError).context).toMatchObject({ table: 'blocks', id: 'blk_1' })
    }
  })
})

describe('decodeEnumOr', () => {
  const severitySchema = v.picklist(['normal', 'high'])

  it('returns a known value', () => {
    expect(decodeEnumOr(severitySchema, 'high', 'normal', ctx)).toBe('high')
  })

  it('falls back (not throws) on an unknown value', () => {
    expect(decodeEnumOr(severitySchema, 'critical', 'normal', ctx)).toBe('normal')
  })
})

describe('decodeJson', () => {
  const schema = v.object({ a: v.number() })

  it('parses and validates a well-formed blob', () => {
    expect(decodeJson(schema, '{"a":1}', ctx)).toEqual({ a: 1 })
  })

  it('throws on malformed JSON', () => {
    expect(() => decodeJson(schema, '{not json', ctx)).toThrow(DataIntegrityError)
  })

  it('throws on a shape mismatch', () => {
    expect(() => decodeJson(schema, '{"a":"str"}', ctx)).toThrow(DataIntegrityError)
  })
})

describe('tryDecodeRow', () => {
  it('returns the mapped value when it succeeds', () => {
    expect(tryDecodeRow(() => 42, ctx)).toBe(42)
  })

  it('returns null (drops the row) when a DataIntegrityError bubbles up', () => {
    expect(
      tryDecodeRow(() => {
        throw new DataIntegrityError('corrupt', ctx)
      }, ctx),
    ).toBeNull()
  })

  it('rethrows a non-integrity error', () => {
    expect(() =>
      tryDecodeRow(() => {
        throw new TypeError('unexpected')
      }, ctx),
    ).toThrow(TypeError)
  })
})

describe('tryDecodeRows', () => {
  const rows = [{ id: 'a', v: 1 }, { id: 'bad' }, { id: 'b', v: 2 }] as { id: string; v?: number }[]
  const rowCtx = (row: { id: string }) => ({ table: 'blocks', id: row.id })

  it('maps every row when none are corrupt', () => {
    expect(tryDecodeRows([rows[0]!, rows[2]!], (r) => r.v, rowCtx)).toEqual([1, 2])
  })

  it('drops only the corrupt rows and keeps the rest', () => {
    const out = tryDecodeRows(
      rows,
      (r) => {
        if (r.v === undefined) throw new DataIntegrityError('missing v', rowCtx(r))
        return r.v
      },
      rowCtx,
    )
    expect(out).toEqual([1, 2])
  })

  it('rethrows a non-integrity error (does not silently drop)', () => {
    expect(() =>
      tryDecodeRows(
        rows,
        () => {
          throw new TypeError('unexpected')
        },
        rowCtx,
      ),
    ).toThrow(TypeError)
  })
})
