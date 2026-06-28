import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeDesignProvider } from './ClaudeDesignProvider.js'
import { DocumentHttpError } from './http.js'

// Fetch-shell tests for the Claude Design provider: list → fetch → normalize over a stubbed
// `fetch`, the `{ content }` JSON-envelope unwrap, host-pinning + Bearer auth, and the
// empty-project failure. The pure normalizer is covered in claudeDesign.logic.test.ts.

const TOKEN = { apiToken: 'sk-ant-test' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ClaudeDesignProvider.normalizeConnection', () => {
  it('requires and trims a token', () => {
    const p = new ClaudeDesignProvider()
    expect(() => p.normalizeConnection({})).toThrow(/personal access token/)
    expect(p.normalizeConnection({ apiToken: ' sk-ant-x ' })).toEqual({
      credentials: { apiToken: 'sk-ant-x' },
      label: 'Claude Design',
    })
  })
})

describe('ClaudeDesignProvider.fetchDocument', () => {
  it('lists + fetches a project and renders components + tokens; pins host, sends Bearer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(new URL(url).hostname).toBe('api.claude.com')
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-ant-test')
        if (url.endsWith('/files')) {
          return new Response(
            JSON.stringify({
              files: ['_ds_manifest.json', 'tokens.css', 'components/button.html'],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('_ds_manifest.json')) {
          return new Response(
            JSON.stringify({ name: 'Acme', cards: [{ name: 'Primary', group: 'Buttons' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.endsWith('.css')) {
          return new Response(':root{--color-primary:#ff0000}', {
            status: 200,
            headers: { 'content-type': 'text/css' },
          })
        }
        if (url.endsWith('.html')) {
          return new Response('<!-- @dsCard group="Ignored" name="X" --><div>hi</div>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )

    const doc = await new ClaudeDesignProvider().fetchDocument(TOKEN, 'proj_ABC')
    expect(doc.title).toBe('Acme')
    expect(doc.url).toBe('https://claude.ai/design/proj_ABC')
    expect(doc.body).toContain('## Acme')
    expect(doc.body).toContain('#### Buttons')
    expect(doc.body).toContain('- Primary')
    expect(doc.body).toContain('--color-primary = #ff0000')
    // The manifest is authoritative, so the HTML @dsCard inventory is not used.
    expect(doc.body).not.toContain('Ignored')
  })

  it('unwraps a { content } JSON envelope for a single-file ref', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ content: '<h1>Primary button</h1>' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    const doc = await new ClaudeDesignProvider().fetchDocument(
      TOKEN,
      'proj::components/button.html',
    )
    expect(doc.body).toContain('### Content')
    expect(doc.body).toContain('Primary button')
  })

  it('throws DocumentHttpError when the project has no readable files', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ files: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    await expect(
      new ClaudeDesignProvider().fetchDocument(TOKEN, 'proj_ABC'),
    ).rejects.toBeInstanceOf(DocumentHttpError)
  })
})
