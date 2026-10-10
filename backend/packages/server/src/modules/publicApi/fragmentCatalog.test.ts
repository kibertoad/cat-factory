import type { ResolvedCatalogEntry } from '@cat-factory/kernel'
import type { FragmentLibraryModule } from '@cat-factory/orchestration'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import { publicFragmentController } from './PublicFragmentController.js'
import { assertFragmentsResolvable, catalogPage } from './fragmentCatalog.js'

// The half of this surface the cross-runtime conformance suite structurally cannot reach: what
// `/api/v1/prompt-fragments` and a `fragmentIds` create do on a deployment that wired NO standards
// library. Both facades gate the module on `fragmentLibrary.enabled`, and the conformance harness
// runs with it on, so the shipped configuration where `container.fragmentLibrary` is genuinely
// undefined has no assertion over there at all.
//
// It is the case worth pinning precisely because the wrong answer is a plausible one. A library
// stubbed in rather than left absent resolves an EMPTY catalog, which serves `200 {fragments: []}`
// and refuses every create with `prompt_fragment_not_found`: an unwired capability rendered as a
// board that has authored no standards, which are different facts needing different fixes.

function entry(id: string, over: Partial<ResolvedCatalogEntry> = {}): ResolvedCatalogEntry {
  return {
    id,
    version: '1.0.0',
    title: id,
    category: null,
    summary: `Summary of ${id}`,
    body: `BODY OF ${id}`,
    brief: null,
    briefScope: { ownerKind: 'workspace', ownerId: 'ws_1' },
    appliesTo: null,
    tags: null,
    source: null,
    documentRef: null,
    docViaWorkspaceId: null,
    resolvedAt: null,
    tier: 'workspace',
    ...over,
  }
}

/** A library whose merged catalog is exactly these entries, in the order the merge would sort them. */
function libraryOf(ids: string[]): FragmentLibraryModule {
  const catalog = [...ids].sort().map((id) => entry(id))
  return {
    libraryService: { resolveCatalog: async () => catalog },
  } as unknown as FragmentLibraryModule
}

/** The list route over a container that may or may not have wired the module. */
function listRoute(library: FragmentLibraryModule | undefined) {
  const container = {
    fragmentLibrary: library,
    publicApiKeys: {
      authenticate: async () => ({
        workspaceId: 'ws_1',
        scope: 'write',
        keyId: 'pak_1',
        actsAsUserId: null,
      }),
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', publicFragmentController())

  return async (query = '') => {
    const res = await app.request(`/api/v1/prompt-fragments${query}`, {
      headers: { authorization: 'Bearer good' },
    })
    return { status: res.status, body: (await res.json()) as never }
  }
}

const reasonOf = (body: unknown) =>
  (body as { error?: { details?: { reason?: string } } }).error?.details?.reason

describe('the public best-practice-standard catalog with no library wired', () => {
  it('answers the list with a 503 naming the unwired capability, not an empty catalog', async () => {
    const { status, body } = await listRoute(undefined)()

    expect(status).toBe(503)
    expect(reasonOf(body)).toBe('prompt_fragments_unwired')
    // The SPA and a headless client both branch on the reason, so the generic status class alone
    // would attribute a missing module and a board with nothing authored to the same cause.
    expect(body).not.toMatchObject({ fragments: [] })
  })

  it('refuses a create that named standards with the same 503, and lets one that named none pass', async () => {
    await expect(assertFragmentsResolvable(undefined, 'ws_1', ['org.x'])).rejects.toMatchObject({
      // `unavailable` is the 503 status class; the machine-readable cause is `details.reason`.
      code: 'unavailable',
      details: { reason: 'prompt_fragments_unwired' },
    })
    // Fires ONLY for a caller that depends on the module: a deployment with no library keeps
    // creating tasks exactly as it did before the field existed.
    await expect(assertFragmentsResolvable(undefined, 'ws_1', undefined)).resolves.toBeUndefined()
    await expect(assertFragmentsResolvable(undefined, 'ws_1', [])).resolves.toBeUndefined()
  })
})

describe('the public best-practice-standard catalog page', () => {
  it('serves a bounded window ordered by id, and reports whether more remain', async () => {
    const library = libraryOf(['b.two', 'a.one', 'c.three'])

    const first = await catalogPage(library, 'ws_1', { limit: 2 })
    expect(first.fragments.map((f) => f.fragmentId)).toEqual(['a.one', 'b.two'])
    expect(first.hasMore).toBe(true)

    const second = await catalogPage(library, 'ws_1', { limit: 2, afterId: 'b.two' })
    expect(second.fragments.map((f) => f.fragmentId)).toEqual(['c.three'])
    expect(second.hasMore).toBe(false)
  })

  it('serves an empty LAST page for a cursor the catalog has since passed', async () => {
    // A standard deleted between two pages leaves a client holding a cursor naming an id that is
    // no longer there. Resuming at the top would hand it the first page again and loop it forever,
    // so the honest answer is the end of the list.
    const page = await catalogPage(libraryOf(['a.one', 'b.two']), 'ws_1', {
      limit: 10,
      afterId: 'z.gone',
    })

    expect(page.fragments).toEqual([])
    expect(page.hasMore).toBe(false)
  })

  it('publishes identity and metadata, never the guidance body', async () => {
    const library = libraryOf(['org.only'])

    const page = await catalogPage(library, 'ws_1', { limit: 10 })

    expect(page.fragments[0]).toEqual({
      fragmentId: 'org.only',
      title: 'org.only',
      // An uncategorised entry publishes `''`, the same value the management wire shape carries:
      // a picker groups by this string, and a missing key would be a second absent-vs-empty case.
      category: '',
      summary: 'Summary of org.only',
      version: '1.0.0',
      tier: 'workspace',
      tags: [],
    })
    expect(JSON.stringify(page.fragments)).not.toContain('BODY OF')
  })
})
