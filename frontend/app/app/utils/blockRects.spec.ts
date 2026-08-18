import { describe, it, expect, vi, beforeEach } from 'vitest'
import { measureBlocks } from './blockRects'

function card(id: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-block-id', id)
  return el
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('measureBlocks', () => {
  it('resolves each rendered card by its block id', () => {
    const a = card('a')
    const b = card('b')
    document.body.append(a, b)

    const blocks = measureBlocks(document)
    expect(blocks.elementFor('a')).toBe(a)
    expect(blocks.elementFor('b')).toBe(b)
    expect(blocks.elementFor('missing')).toBeNull()
  })

  it('resolves the first card in document order, as a bare querySelector did', () => {
    const onBoard = card('a')
    const inOverlay = card('a')
    document.body.append(onBoard, inOverlay)

    expect(measureBlocks(document).elementFor('a')).toBe(onBoard)
  })

  it('measures an element once per pass however many links read it', () => {
    const a = card('a')
    document.body.append(a)
    const measure = vi.spyOn(a, 'getBoundingClientRect')

    const blocks = measureBlocks(document)
    const first = blocks.rectFor(a)
    expect(blocks.rectFor(a)).toBe(first)
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('is a snapshot: a later pass measures again', () => {
    const a = card('a')
    document.body.append(a)
    const measure = vi.spyOn(a, 'getBoundingClientRect')

    measureBlocks(document).rectFor(a)
    measureBlocks(document).rectFor(a)
    expect(measure).toHaveBeenCalledTimes(2)
  })

  it('scopes the pass to the root it was given', () => {
    const outside = card('a')
    const root = document.createElement('div')
    const inside = card('b')
    root.append(inside)
    document.body.append(outside, root)

    const blocks = measureBlocks(root)
    expect(blocks.elementFor('b')).toBe(inside)
    expect(blocks.elementFor('a')).toBeNull()
  })
})
