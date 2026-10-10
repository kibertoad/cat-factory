import { afterEach, describe, expect, it, vi } from 'vitest'
import { FigmaProvider } from './FigmaProvider.js'
import { MAX_RENDERS } from './figma.logic.js'

// The RENDER half of the Figma provider: turning a reference into downloaded PNG bytes.
//
// What these pin is the property the rest of the pixel work rests on — a render pass reports
// exactly what it retrieved and exactly what it did not, and it never lets one frame's problem
// become the import's. The download is also the one request this provider makes to a host that is
// not `api.figma.com`, so the credential boundary and the host guard are asserted here rather than
// left to the shared http helper's own tests: a signed asset URL comes back inside a response
// BODY, which is precisely the shape an SSRF arrives in.

const TOKEN = { apiToken: 'figd_test' }
const RENDER_HOST = 'https://s3-alpha-sig.figma.com'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function pngResponse(byte: number): Response {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, byte]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
}

/** A file outline with `count` top-level frames on one page, named `Frame N`. */
function outline(count: number): unknown {
  return {
    name: 'Design system',
    version: 'v1',
    document: {
      id: '0:0',
      children: [
        {
          id: '0:1',
          name: 'Page 1',
          type: 'CANVAS',
          children: Array.from({ length: count }, (_, i) => ({
            id: `1:${i}`,
            name: `Frame ${i}`,
            type: 'FRAME',
          })),
        },
      ],
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FigmaProvider.fetchRenders', () => {
  it('renders the named frame, names it by its own title, and sends NO credential to the CDN', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> })
        if (url.includes('/nodes')) {
          return jsonResponse({ nodes: { '1:2': { document: { id: '1:2', name: 'Checkout' } } } })
        }
        if (url.includes('/images/')) {
          return jsonResponse({ images: { '1:2': `${RENDER_HOST}/signed/checkout.png` } })
        }
        return pngResponse(1)
      }),
    )

    const result = await new FigmaProvider().fetchRenders(TOKEN, 'file1:1:2', 'ws_1')

    expect(result.failed).toBe(0)
    expect(result.renders).toHaveLength(1)
    // The `view` is the frame's own name because that is the pairing key a captured screenshot is
    // matched against; an id pairs with nothing a UI tester would ever produce.
    expect(result.renders[0]?.view).toBe('Checkout')
    expect(result.renders[0]?.contentType).toBe('image/png')
    expect([...(result.renders[0]?.bytes ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47, 1])

    const download = calls.at(-1)!
    expect(new URL(download.url).hostname).toBe('s3-alpha-sig.figma.com')
    // The asset URL is already signed. Sending the API token to a bucket host would hand the
    // workspace's Figma credential to a host it has no business reaching.
    expect(download.headers['x-figma-token']).toBeUndefined()
    expect(download.headers.authorization).toBeUndefined()
  })

  it('caps a whole-file render at MAX_RENDERS frames in document order', async () => {
    let requestedIds: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/images/')) {
          requestedIds = new URL(url).searchParams.get('ids')!.split(',')
          return jsonResponse({
            images: Object.fromEntries(
              requestedIds.map((id) => [id, `${RENDER_HOST}/signed/${id}.png`]),
            ),
          })
        }
        if (url.includes('/nodes')) return jsonResponse({ nodes: {} })
        return url.includes('s3-alpha-sig') ? pngResponse(2) : jsonResponse(outline(20))
      }),
    )

    const result = await new FigmaProvider().fetchRenders(TOKEN, 'file1', 'ws_1')

    // Fewer than the twelve frames the TEXT import covers: the two caps bound different budgets
    // (context bytes vs blob storage), so they are deliberately different numbers.
    expect(requestedIds).toHaveLength(MAX_RENDERS)
    expect(requestedIds[0]).toBe('1:0')
    expect(result.renders.map((r) => r.view)).toEqual(
      Array.from({ length: MAX_RENDERS }, (_, i) => `Frame ${i}`),
    )
    expect(result.failed).toBe(0)
    // The frames the cap left out are COUNTED, kept apart from `failed`: a retry fixes a failure
    // and never a cap. Reported as zero, six pictures of a twenty-frame file would land on the row
    // as "every image the source offered was retrieved and retained".
    expect(result.capped).toBe(20 - MAX_RENDERS)
  })

  it('renders the plan it was handed, without re-reading the file it came from', async () => {
    // The import fetches the body and the renders back to back off one revision, so the structural
    // read that named these frames has already happened. Repeating it spends a second call against
    // the rate-limited API to relearn ids and names the caller is holding.
    const fetched: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetched.push(url)
        if (url.includes('/images/')) {
          return jsonResponse({ images: { '1:7': `${RENDER_HOST}/signed/seven.png` } })
        }
        return pngResponse(7)
      }),
    )

    const result = await new FigmaProvider().fetchRenders(TOKEN, 'file1', 'ws_1', {
      targets: [{ id: '1:7', view: 'Settings' }],
      capped: 4,
    })

    expect(result.renders.map((r) => r.view)).toEqual(['Settings'])
    // The plan's own cap rides through: it counts frames of THIS file that no picture covers,
    // whoever discovered them.
    expect(result.capped).toBe(4)
    expect(fetched.some((u) => u.includes('?depth=') || u.includes('/nodes'))).toBe(false)
  })

  it('counts a frame Figma rendered nothing for, and one whose download fails, WITH their causes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/images/')) {
          return jsonResponse({
            // `1:1` has no URL at all: Figma rendered nothing for it. `1:2` has one that 429s.
            images: {
              '1:0': `${RENDER_HOST}/ok.png`,
              '1:1': null,
              '1:2': `${RENDER_HOST}/rate-limited.png`,
            },
          })
        }
        if (url.includes('/nodes')) return jsonResponse({ nodes: {} })
        if (url.includes('rate-limited')) return new Response('slow down', { status: 429 })
        if (url.includes('s3-alpha-sig')) return pngResponse(3)
        return jsonResponse(outline(3))
      }),
    )

    const result = await new FigmaProvider().fetchRenders(TOKEN, 'file1', 'ws_1')

    // One frame survives, so the import is PARTLY illustrated rather than a failure: the picture
    // that did arrive is worth keeping, and the count is what tells a reader the rest are missing.
    expect(result.renders.map((r) => r.view)).toEqual(['Frame 0'])
    expect(result.failed).toBe(2)
    // Two distinct causes, kept apart: "Figma would not render this" and "the download failed with
    // a 429" ask for different things (open the frame vs wait and retry).
    expect(result.causes).toEqual(['HTTP 429', 'no render returned'])
  })

  it('refuses a render URL pointed off Figma’s asset hosts, and counts it as a failure', async () => {
    const fetched: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetched.push(url)
        if (url.includes('/nodes')) {
          return jsonResponse({ nodes: { '1:2': { document: { id: '1:2', name: 'Checkout' } } } })
        }
        // A response body claiming the render lives on an internal address: the SSRF shape this
        // download path is exposed to, since the URL is data rather than a constant.
        return jsonResponse({ images: { '1:2': 'https://169.254.169.254/latest/meta-data' } })
      }),
    )

    const result = await new FigmaProvider().fetchRenders(TOKEN, 'file1:1:2', 'ws_1')

    expect(result.renders).toEqual([])
    expect(result.failed).toBe(1)
    expect(result.causes[0]).toMatch(/disallowed host/)
    // The guard refuses BEFORE the request, so the internal address is never reached at all.
    expect(fetched.some((u) => u.includes('169.254.169.254'))).toBe(false)
  })

  it('answers empty for a file with no frames rather than asking Figma to render nothing', async () => {
    const fetched: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetched.push(url)
        return jsonResponse(outline(0))
      }),
    )

    const result = await new FigmaProvider().fetchRenders(TOKEN, 'file1', 'ws_1')

    expect(result).toEqual({ renders: [], failed: 0, capped: 0, causes: [] })
    // No `/images` call: an empty ids list is a request the endpoint answers with an error, which
    // would read as a failed render pass rather than as a design with nothing in it.
    expect(fetched.some((u) => u.includes('/images/'))).toBe(false)
  })
})
