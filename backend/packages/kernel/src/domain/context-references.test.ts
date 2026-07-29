import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.js'
import {
  assertContextDocumentsReadable,
  assertContextReferencesFit,
  CONTEXT_DOCUMENT_UNREADABLE,
  CONTEXT_DOCUMENTS_OVER_BUDGET,
  hasReadableContent,
} from './context-references.js'

describe('hasReadableContent', () => {
  it('accepts a body, and an excerpt when the body is blank (the materialised fallback)', () => {
    expect(hasReadableContent({ body: '# Spec', excerpt: '' })).toBe(true)
    expect(hasReadableContent({ body: '', excerpt: 'Token bucket.' })).toBe(true)
  })

  it('rejects blank, whitespace-only and absent content alike', () => {
    // Whitespace matters: `body: '\n\n'` materialises a file with a header and nothing under it,
    // which reads to an agent exactly like a document that had nothing to say.
    expect(hasReadableContent({ body: '  \n ', excerpt: '' })).toBe(false)
    expect(hasReadableContent({})).toBe(false)
    expect(hasReadableContent({ body: null, excerpt: null })).toBe(false)
  })
})

describe('assertContextDocumentsReadable', () => {
  it('is a no-op when nothing is unreadable, so callers can assert unconditionally', () => {
    expect(() => assertContextDocumentsReadable([])).not.toThrow()
  })

  it('names every unreadable reference and both remedies', () => {
    const error = (() => {
      try {
        assertContextDocumentsReadable([
          { title: 'Payments RFC', url: 'https://wiki/1' },
          { title: 'Pricing PRD', url: 'https://wiki/2' },
        ])
        return null
      } catch (e) {
        return e as ValidationError
      }
    })()
    expect(error).toBeInstanceOf(ValidationError)
    expect(error!.message).toContain('"Payments RFC" (https://wiki/1)')
    expect(error!.message).toContain('"Pricing PRD" (https://wiki/2)')
    // Re-import OR detach: a task is allowed to proceed without a document, just never silently.
    expect(error!.message).toContain('Re-import')
    expect(error!.message).toContain('detach it from the task')
    expect(error!.details?.reason).toBe(CONTEXT_DOCUMENT_UNREADABLE)
    expect(error!.details?.references).toEqual(['https://wiki/1', 'https://wiki/2'])
  })

  it('falls back to the title when a reference carries no URL', () => {
    expect(() => assertContextDocumentsReadable([{ title: 'Local notes', url: '' }])).toThrow(
      /"Local notes"/,
    )
  })
})

describe('assertContextReferencesFit', () => {
  it('is a no-op when everything fits', () => {
    expect(() => assertContextReferencesFit([], { totalBytes: 10, budgetBytes: 100 })).not.toThrow()
  })

  it('names what did not fit, with both sizes in KB and the machine-readable cause', () => {
    const error = (() => {
      try {
        assertContextReferencesFit([{ title: 'Huge RFC', url: 'https://wiki/9' }], {
          totalBytes: 300 * 1024,
          budgetBytes: 256 * 1024,
        })
        return null
      } catch (e) {
        return e as ValidationError
      }
    })()
    expect(error!.message).toContain('300 KB')
    expect(error!.message).toContain('256 KB')
    expect(error!.message).toContain('"Huge RFC" (https://wiki/9)')
    expect(error!.details?.reason).toBe(CONTEXT_DOCUMENTS_OVER_BUDGET)
    expect(error!.details?.totalBytes).toBe(300 * 1024)
  })
})
