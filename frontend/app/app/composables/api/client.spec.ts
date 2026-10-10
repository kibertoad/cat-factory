import type { ApiContract } from '@toad-contracts/core'
import { describe, expect, it } from 'vitest'
import { type SendParams, withoutUndefinedQueryParams } from '~/composables/api/client'

// An omitted optional query param used to reach the server as `key=`: the contract client
// serialises with `fast-querystring`, whose `stringify({ blockId: undefined })` is `'blockId='`,
// and request validation waves the key through because `v.optional(...)` accepts `undefined`. On
// `listTasksContract`, whose `blockId` carries a `minLength(1)`, that made every unscoped
// `listTasks()` a guaranteed 400. These lock the strip in.

// The helper is contract-generic and only ever reads `queryParams`, so the cases below describe
// request params structurally rather than picking a real contract per shape.
type Params = Record<string, unknown>
const strip = (params: Params): Params =>
  withoutUndefinedQueryParams(params as SendParams<ApiContract>) as Params

describe('withoutUndefinedQueryParams', () => {
  it('drops undefined-valued query keys so they never reach the query string', () => {
    const out = strip({ pathPrefix: '/workspaces/ws_1', queryParams: { blockId: undefined } })
    expect(out.queryParams).toEqual({})
  })

  // The guard against "fix" it with a falsy check: 0, false and '' are all values a caller
  // deliberately sent, and only `undefined` means absent.
  it('keeps defined values, including falsy ones a caller meant to send', () => {
    const out = strip({ queryParams: { blockId: 'blk_1', page: 0, all: false, q: '' } })
    expect(out.queryParams).toEqual({ blockId: 'blk_1', page: 0, all: false, q: '' })
  })

  it('leaves other request params untouched', () => {
    const params = {
      pathPrefix: '/workspaces/ws_1',
      pathParams: { source: 'jira' },
      body: { a: 1 },
    }
    expect(strip(params)).toEqual(params)
  })

  it('returns the same object when there is nothing to strip', () => {
    const params = { queryParams: { blockId: 'blk_1' } }
    expect(strip(params)).toBe(params)
    const noQuery = { pathPrefix: '/workspaces/ws_1' }
    expect(strip(noQuery)).toBe(noQuery)
  })
})
