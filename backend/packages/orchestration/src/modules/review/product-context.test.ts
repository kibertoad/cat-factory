import { describe, expect, it } from 'vitest'
import { productIsIdentifiedFrom, renderProductContextLines } from './product-context.js'

describe('renderProductContextLines', () => {
  it('names a resolved service and its description', () => {
    expect(
      renderProductContextLines(
        { stated: true, frameId: 'blk_1', title: 'billing-api', description: 'Bills customers.' },
        'reason',
      ).join('\n'),
    ).toContain('**billing-api**')
  })

  it('states the absence rather than rendering nothing', () => {
    const lines = renderProductContextLines(
      { stated: false, reason: 'not-under-a-service' },
      'reason',
    )
    expect(lines.join('\n')).toContain('NOT STATED')
  })

  it('tailors the unstated guidance to what the agent is being asked to do', () => {
    const reasoning = renderProductContextLines(
      { stated: false, reason: 'not-under-a-service' },
      'reason',
    ).join('\n')
    const proposing = renderProductContextLines(
      { stated: false, reason: 'not-under-a-service' },
      'propose',
    ).join('\n')
    expect(reasoning).toContain('do not infer a product')
    expect(proposing).toContain('do not adopt a product')
  })

  it('renders nothing when the subject IS the service, or when nothing was resolved', () => {
    expect(
      renderProductContextLines({ stated: false, reason: 'block-is-the-service' }, 'reason'),
    ).toEqual([])
    expect(renderProductContextLines(undefined, 'reason')).toEqual([])
  })

  it('appends extra grounding only under a resolved service, and only when non-empty', () => {
    const withExtra = renderProductContextLines(
      { stated: true, frameId: 'b', title: 'api' },
      'reason',
      { label: 'From the spec:', body: 'Bills monthly.' },
    ).join('\n')
    expect(withExtra).toContain('From the spec:')
    const empty = renderProductContextLines(
      { stated: true, frameId: 'b', title: 'api' },
      'reason',
      {
        label: 'From the spec:',
        body: '   ',
      },
    ).join('\n')
    expect(empty).not.toContain('From the spec:')
  })
})

describe('productIsIdentifiedFrom', () => {
  it('treats "the subject IS the service" as identified and "no service" as not', () => {
    expect(productIsIdentifiedFrom({ stated: false, reason: 'block-is-the-service' })).toBe(true)
    expect(productIsIdentifiedFrom({ stated: false, reason: 'not-under-a-service' })).toBe(false)
    expect(productIsIdentifiedFrom({ stated: true, frameId: 'b', title: 'api' })).toBe(true)
    expect(productIsIdentifiedFrom(undefined)).toBe(false)
  })
})
