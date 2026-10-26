import { describe, expect, it } from 'vitest'
import { connectionRowState } from '~/utils/connectionRowState'

describe('connectionRowState', () => {
  it('shows rows the store holds, whatever the load is doing', () => {
    expect(connectionRowState(true, { loading: true, loadFailed: true })).toBe('connected')
    expect(connectionRowState(true, { loading: false, loadFailed: true })).toBe('connected')
  })

  it('reads an in-flight load as checking, even after a failed one', () => {
    expect(connectionRowState(false, { loading: true, loadFailed: false })).toBe('checking')
    expect(connectionRowState(false, { loading: true, loadFailed: true })).toBe('checking')
  })

  it('tells a failed load from nothing connected', () => {
    expect(connectionRowState(false, { loading: false, loadFailed: true })).toBe('failed')
    expect(connectionRowState(false, { loading: false, loadFailed: false })).toBe('idle')
  })
})
