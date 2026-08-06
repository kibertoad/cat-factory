import { describe, expect, it } from 'vitest'
import type { ResolvedDocumentRef } from '@cat-factory/contracts'
import { ApiError } from '~/composables/api/errors'
import {
  classifyRefFailure,
  refCandidateOf,
  refRowFor,
  type RefState,
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
    // A link with the scheme pasted off is still a link.
    expect(refCandidateOf('notion.so/Checkout-PRD-1f2e3d', true)).toBe(
      'notion.so/Checkout-PRD-1f2e3d',
    )
  })

  it('does not read a PHRASE as a reference just because it carries punctuation', () => {
    // The consequence of a false positive changed with this surface: it used to cost an ignorable
    // extra row, and now it renders "Not a Notion reference" in amber above the results for that
    // very phrase. Whitespace is the tell, so `/` and `#` inside a title search no longer qualify.
    expect(refCandidateOf('auth/login flow', true)).toBeNull()
    expect(refCandidateOf('sprint #4 plan', true)).toBeNull()
    expect(refCandidateOf('roadmap Q3/Q4', true)).toBeNull()
  })

  it('accepts the bare id shapes no title could be confused with', () => {
    // Worth ASKING about (the backend stays the judge): a Notion id dashed or dashless, and a
    // Confluence page id. A single unrecognised word is a search, not an id.
    expect(refCandidateOf('1f2e3d4c5b6a78901234567890abcdef', true)).toBe(
      '1f2e3d4c5b6a78901234567890abcdef',
    )
    expect(refCandidateOf('1f2e3d4c-5b6a-7890-1234-567890abcdef', true)).toBe(
      '1f2e3d4c-5b6a-7890-1234-567890abcdef',
    )
    expect(refCandidateOf('123456', true)).toBe('123456')
    expect(refCandidateOf('authentication', true)).toBeNull()
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
    droppedScope: null,
  }
  const ok = (ref: ResolvedDocumentRef): RefState => ({ status: 'ok', ref })

  it('labels the row with the CANONICAL form and flags that the paste was trimmed', () => {
    const row = refRowFor(
      ok(resolved),
      'https://www.figma.com/design/6k0gqOC6ppDMAziCmZ2Gv9/Project-Redwood--Autopilot-AI-' +
        '?node-id=5765-57229&p=f&t=J1SrKp6sgJm9CIeQ-0',
    )
    expect(row).toEqual({
      externalId: resolved.externalId,
      source: 'figma',
      canonicalUrl: resolved.canonicalUrl,
      label: resolved.canonicalUrl,
      trimmed: true,
      droppedScope: null,
      unchecked: false,
    })
  })

  it('does not claim a trim when the canonical form is what was pasted', () => {
    expect(refRowFor(ok(resolved), ` ${resolved.canonicalUrl} `)).toMatchObject({ trimmed: false })
  })

  it('carries a WIDENED reference separately from a trim', () => {
    // The two are opposite facts wearing the same clothes. A trim resolves the same page; dropping
    // an unreadable `node-id` swaps one frame for the whole design file, and the label alone cannot
    // show it (a whole-file canonical URL looks perfectly well-formed). A row that reported only
    // `trimmed` here is how "I attached this frame" became "the agent read everything".
    const widened = {
      source: 'figma' as const,
      externalId: '6k0gqOC6ppDMAziCmZ2Gv9',
      canonicalUrl: 'https://www.figma.com/design/6k0gqOC6ppDMAziCmZ2Gv9',
      droppedScope: 'I2649:14930;2649:14746',
    }
    const row = refRowFor(
      ok(widened),
      'https://www.figma.com/design/6k0gqOC6ppDMAziCmZ2Gv9/R?node-id=I2649:14930;2649:14746',
    )
    expect(row).toMatchObject({ trimmed: true, droppedScope: 'I2649:14930;2649:14746' })
  })

  it('prefers the imported page title, and falls back to the id when there is no URL to show', () => {
    expect(refRowFor(ok(resolved), resolved.canonicalUrl, 'Autopilot Home')?.label).toBe(
      'Autopilot Home',
    )
    // A Confluence page id cannot be rendered back as a URL without the site base, so the id
    // itself is the canonical form, not a missing one.
    const noUrl = {
      source: 'confluence' as const,
      externalId: '4567',
      canonicalUrl: null,
      droppedScope: null,
    }
    expect(refRowFor(ok(noUrl), '4567')).toMatchObject({ label: '4567', trimmed: false })
  })

  it('still offers an UNJUDGED reference, carrying the pasted text', () => {
    // "The source refused this" and "we could not ask" are different facts, and only the first is
    // evidence against a link. Suppressing the row for the second made a transient 502 or an
    // offline moment as final as a refusal: attaching a perfectly good link became impossible,
    // where the import had always been the backstop.
    const row = refRowFor({ status: 'unchecked', message: 'Failed to fetch' }, ' notion.so/abc ')
    expect(row).toEqual({
      externalId: 'notion.so/abc',
      // Only the resolve answers which source claims a paste; the picker supplies the selected one.
      source: null,
      canonicalUrl: null,
      label: 'notion.so/abc',
      trimmed: false,
      droppedScope: null,
      unchecked: true,
    })
  })

  it('offers nothing while checking, or once the source has refused', () => {
    expect(refRowFor({ status: 'none' }, 'x')).toBeNull()
    expect(refRowFor({ status: 'checking' }, 'x')).toBeNull()
    expect(refRowFor({ status: 'rejected', reason: 'document_ref_unrecognized' }, 'x')).toBeNull()
  })
})
