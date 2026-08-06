import { describe, expect, it } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import {
  classifyRefFailure,
  refCandidateOf,
  refRowFor,
} from '~/components/documents/ContextDocumentPicker.logic'

// The picker used to stage whatever text sat in its input, so a Figma share link (title segment
// plus `?p=`/`&t=` params) was accepted verbatim and a link the source could not read at all was
// accepted just as readily, the verdict arriving as a failed import after the task was created.
// These three functions are what makes the verdict arrive first, and each is pinned here.

/** The refusal envelope the resolve endpoint answers with, as a thrown `ApiError`. */
function refusal(details: Record<string, unknown>): ApiError {
  return new ApiError(422, { error: { code: 'validation', message: 'nope', details } })
}

describe('refCandidateOf', () => {
  it('treats any non-empty text as a reference for a source with no catalogue search', () => {
    // Pasting is the only way to attach a page to such a source, so a bare id must resolve.
    expect(refCandidateOf('  6k0gqOC6ppDMAziCmZ2Gv9  ', false)).toBe('6k0gqOC6ppDMAziCmZ2Gv9')
    expect(refCandidateOf('   ', false)).toBeNull()
  })

  it('leaves a plain search phrase alone on a searchable source', () => {
    // Resolving every keystroke of a title search would render a refusal at someone who is
    // simply searching, which is the opposite of the point.
    expect(refCandidateOf('export requirements', true)).toBeNull()
    expect(refCandidateOf('https://www.figma.com/design/K/T?node-id=1-2', true)).toBe(
      'https://www.figma.com/design/K/T?node-id=1-2',
    )
    expect(refCandidateOf('acme/repo:docs/x.md', true)).toBe('acme/repo:docs/x.md')
    expect(refCandidateOf('#412', true)).toBe('#412')
  })
})

describe('classifyRefFailure', () => {
  it('reads the two refusal reasons and the detail each correction needs', () => {
    expect(
      classifyRefFailure(
        refusal({ reason: 'document_ref_claimed_by_other_source', claimedBy: 'figma' }),
      ),
    ).toEqual({
      status: 'rejected',
      reason: 'document_ref_claimed_by_other_source',
      claimedBy: 'figma',
    })

    expect(
      classifyRefFailure(refusal({ reason: 'document_ref_unrecognized', expected: 'https://…' })),
    ).toEqual({ status: 'rejected', reason: 'document_ref_unrecognized', expected: 'https://…' })
  })

  it('leaves the reference UNCHECKED when the call failed rather than the source refusing', () => {
    // A 502, an offline browser or a proxy's own error page says nothing about the link. Reading
    // any error as a refusal would send the user off to fix a link that was fine.
    expect(classifyRefFailure(new Error('Failed to fetch'))).toEqual({
      status: 'unchecked',
      message: 'Failed to fetch',
    })
    expect(classifyRefFailure(new ApiError(502, '<html>bad gateway</html>')).status).toBe(
      'unchecked',
    )
  })

  it('does not trust a reason outside the contract vocabulary', () => {
    // An older or newer backend can name a reason this build has no copy for; rendering it as a
    // refusal would show the user a blank explanation for a link that may be perfectly good.
    expect(classifyRefFailure(refusal({ reason: 'something_new' })).status).toBe('unchecked')
  })
})

describe('refRowFor', () => {
  const resolved = {
    source: 'figma' as const,
    externalId: '6k0gqOC6ppDMAziCmZ2Gv9:5765:57229',
    canonicalUrl: 'https://www.figma.com/design/6k0gqOC6ppDMAziCmZ2Gv9?node-id=5765-57229',
  }

  it('labels the row with the CANONICAL form and flags that the paste was trimmed', () => {
    const row = refRowFor(
      resolved,
      'https://www.figma.com/design/6k0gqOC6ppDMAziCmZ2Gv9/Project-Redwood--Autopilot-AI-' +
        '?node-id=5765-57229&p=f&t=J1SrKp6sgJm9CIeQ-0',
    )
    expect(row).toEqual({ label: resolved.canonicalUrl, trimmed: true })
  })

  it('does not claim a trim when the canonical form is what was pasted', () => {
    expect(refRowFor(resolved, ` ${resolved.canonicalUrl} `)).toEqual({
      label: resolved.canonicalUrl,
      trimmed: false,
    })
  })

  it('prefers the imported page title, and falls back to the id when there is no URL to show', () => {
    expect(refRowFor(resolved, resolved.canonicalUrl, 'Autopilot Home').label).toBe(
      'Autopilot Home',
    )
    // A Confluence page id cannot be rendered back as a URL without the site base, so the id
    // itself is the canonical form, not a missing one.
    const noUrl = { source: 'confluence' as const, externalId: '4567', canonicalUrl: null }
    expect(refRowFor(noUrl, '4567')).toEqual({ label: '4567', trimmed: false })
  })
})
