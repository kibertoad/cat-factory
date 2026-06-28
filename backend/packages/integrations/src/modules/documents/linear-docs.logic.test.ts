import { describe, expect, it } from 'vitest'
import {
  mapLinearDocument,
  mapLinearDocumentSearch,
  parseLinearDocRef,
} from './linear-docs.logic.js'

describe('parseLinearDocRef', () => {
  it('accepts a bare id', () => {
    expect(parseLinearDocRef('  doc_abc123 ')).toBe('doc_abc123')
  })

  it('extracts the id from a document URL', () => {
    expect(parseLinearDocRef('https://linear.app/acme/document/my-doc-9f8a7b')).toBe(
      'my-doc-9f8a7b',
    )
  })

  it('rejects non-linear URLs and empty input', () => {
    expect(parseLinearDocRef('https://example.com/document/x')).toBeNull()
    expect(parseLinearDocRef('https://linear.app/acme/issue/ENG-1')).toBeNull()
    expect(parseLinearDocRef('')).toBeNull()
  })
})

describe('mapLinearDocument', () => {
  it('maps content as Markdown and collapses blank lines', () => {
    const doc = mapLinearDocument({
      document: {
        id: 'd1',
        title: ' Spec ',
        url: 'https://linear.app/d/d1',
        content: 'A\n\n\n\nB',
      },
    })
    expect(doc).toEqual({
      externalId: 'd1',
      title: 'Spec',
      url: 'https://linear.app/d/d1',
      body: 'A\n\nB',
    })
  })

  it('throws when no document came back', () => {
    expect(() => mapLinearDocument({ document: null })).toThrow()
  })
})

describe('mapLinearDocumentSearch', () => {
  it('maps hits and drops id-less rows', () => {
    const hits = mapLinearDocumentSearch({
      documents: { nodes: [{ id: 'd1', title: 'One', url: 'u1' }, { title: 'no id' }] },
    })
    expect(hits).toEqual([
      { source: 'linear', externalId: 'd1', title: 'One', url: 'u1', excerpt: '' },
    ])
  })
})
