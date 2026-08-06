import { describe, expect, it } from 'vitest'
import { ValidationError } from '@cat-factory/kernel'
import type { DocumentSourceProvider, DocumentSourceRegistry } from '@cat-factory/kernel'
import { DocumentImportService } from './DocumentImportService.js'
import { FigmaProvider } from './FigmaProvider.js'
import { NotionProvider } from './NotionProvider.js'
import { ConfluenceProvider } from './ConfluenceProvider.js'

// `resolveRef` is the pre-flight the attach surfaces run BEFORE a task is saved: what a pasted
// link canonicalises to, or a refusal that names which of the two corrections it needs. It is
// pure, so everything here runs with no repository, no connection and no network, which is
// itself the property under test, since that is what lets the picker call it as the user types.
//
// The Figma link below is verbatim what Figma's own "Copy link" button produces: a title
// segment plus `?p=` / `&t=` params riding on the frame's node id. Accepting it verbatim, and
// only discovering the verdict through a failed import after the task existed, is the behaviour
// this replaced.
const PASTED_FIGMA_URL =
  'https://www.figma.com/design/6k0gqOC6ppDMAziCmZ2Gv9/Project-Redwood--Autopilot-AI-' +
  '?node-id=5765-57229&p=f&t=J1SrKp6sgJm9CIeQ-0'

/**
 * A service over REAL providers. `resolveRef` touches none of the other dependencies, so passing
 * them as `undefined` is not a shortcut: a resolve that reached one would fail here rather than
 * quietly work against a stub the production path does not have.
 */
function makeService(providers: DocumentSourceProvider[]): DocumentImportService {
  const registry: DocumentSourceRegistry = {
    get: (kind) => providers.find((p) => p.kind === kind),
    list: () => providers,
  }
  return new DocumentImportService({
    registry,
    documentRepository: undefined as never,
    connectionService: undefined as never,
    workspaceRepository: undefined as never,
    clock: undefined as never,
    idGenerator: undefined as never,
  })
}

const figma = () => new FigmaProvider()
const notion = () => new NotionProvider()
const confluence = () => new ConfluenceProvider()

describe('DocumentImportService.resolveRef', () => {
  it('trims a pasted share link to the canonical form the import will store', () => {
    const service = makeService([figma()])

    expect(service.resolveRef('figma', PASTED_FIGMA_URL)).toEqual({
      source: 'figma',
      externalId: '6k0gqOC6ppDMAziCmZ2Gv9:5765:57229',
      canonicalUrl: 'https://www.figma.com/design/6k0gqOC6ppDMAziCmZ2Gv9?node-id=5765-57229',
    })
  })

  it('round-trips its own canonical id, so a staged reference stays importable', () => {
    // The picker stages the resolved external id rather than the pasted text, so the import that
    // follows parses THAT. A provider whose bare-id branch were stricter than its URL branch
    // would refuse the very reference the pre-flight approved.
    const service = makeService([figma()])
    const first = service.resolveRef('figma', PASTED_FIGMA_URL)

    expect(service.resolveRef('figma', first.externalId)).toEqual(first)
  })

  it('names the source that DOES claim a link, so the correction is switching sources', () => {
    const service = makeService([notion(), figma()])

    const error = grab(() => service.resolveRef('notion', PASTED_FIGMA_URL))
    expect(error.details).toMatchObject({
      reason: 'document_ref_claimed_by_other_source',
      source: 'notion',
      claimedBy: 'figma',
    })
  })

  it('prefers a HOST-PINNED claimant over a blind one, whatever the registration order', () => {
    // `parseConfluenceRef` claims any string carrying a `/pages/<digits>` segment, so a Zeplin or
    // Figma URL that happens to contain one is claimed by BOTH. Registration order deciding is
    // what once had a design link point at Confluence; ordering by confidence makes a pinned
    // claim unstealable. Registered blind-first here precisely so order cannot be what passes it.
    const service = makeService([confluence(), figma(), notion()])
    const withPagesSegment = 'https://www.figma.com/design/AbC123/pages/4567?node-id=1-2'

    expect(service.resolveRef('figma', withPagesSegment).externalId).toBe('AbC123:1:2')
    expect(service.resolveRef('confluence', withPagesSegment).externalId).toBe('4567')
    // Asked from Notion (which claims neither), the hint has to pick between the two claimants.
    const error = grab(() => service.resolveRef('notion', withPagesSegment))
    expect(error.details?.claimedBy).toBe('figma')
  })

  it('refuses text no source recognises, quoting the format this one accepts', () => {
    const service = makeService([figma(), notion()])

    const error = grab(() => service.resolveRef('figma', 'https://example.com/not-a-design'))
    expect(error.details).toMatchObject({
      reason: 'document_ref_unrecognized',
      source: 'figma',
      expected: figma().descriptor.refPlaceholder,
    })
    // No claimant, so the refusal must not invent one: "your link is for another source" and
    // "your link is not a reference" are the two corrections, and offering the wrong one sends
    // the user to a picker that will refuse it too.
    expect(error.details?.claimedBy).toBeUndefined()
  })

  it('scrubs the quoted input, since a pasted link routinely carries a token', () => {
    const service = makeService([figma()])

    const error = grab(() =>
      service.resolveRef('figma', 'https://example.com/x?token=sk-live-abcdef0123456789'),
    )
    expect(error.message).not.toContain('sk-live-abcdef0123456789')
  })

  it('refuses a source this deployment has not wired at all', () => {
    const service = makeService([notion()])

    expect(() => service.resolveRef('figma', PASTED_FIGMA_URL)).toThrow(/unconfigured/i)
  })
})

/** Run a call expected to refuse and hand back the `ValidationError` it threw. */
function grab(run: () => unknown): ValidationError {
  try {
    run()
  } catch (error) {
    if (error instanceof ValidationError) return error
    throw error
  }
  throw new Error('expected the ref to be refused')
}
