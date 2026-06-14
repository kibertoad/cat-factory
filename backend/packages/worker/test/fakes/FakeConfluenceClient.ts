import type {
  ConfluenceClient,
  ConfluenceCredentials,
  ConfluencePageContent,
} from '@cat-factory/core'

/**
 * Deterministic ConfluenceClient for integration tests: serves canned page
 * bodies and records the credentials it was called with, so tests can assert
 * both the import/plan/spawn behaviour and that the connection's token was used.
 * Unregistered pages fall back to a minimal generated page so simple import
 * tests need no setup.
 */
export class FakeConfluenceClient implements ConfluenceClient {
  readonly pages = new Map<string, ConfluencePageContent>()
  readonly calls: { creds: ConfluenceCredentials; pageId: string }[] = []

  constructor(pages: Record<string, Partial<ConfluencePageContent>> = {}) {
    for (const [pageId, partial] of Object.entries(pages)) this.set(pageId, partial)
  }

  /** Register (or replace) a canned page. */
  set(pageId: string, partial: Partial<ConfluencePageContent> = {}): void {
    this.pages.set(pageId, {
      spaceKey: 'ENG',
      title: `Page ${pageId}`,
      url: `https://acme.atlassian.net/wiki/spaces/ENG/pages/${pageId}`,
      version: 1,
      body: '',
      ...partial,
      pageId,
    })
  }

  async getPage(creds: ConfluenceCredentials, pageId: string): Promise<ConfluencePageContent> {
    this.calls.push({ creds, pageId })
    const page = this.pages.get(pageId)
    if (page) return page
    const generated: ConfluencePageContent = {
      pageId,
      spaceKey: 'ENG',
      title: `Page ${pageId}`,
      url: `https://acme.atlassian.net/wiki/spaces/ENG/pages/${pageId}`,
      version: 1,
      body: `<h1>Page ${pageId}</h1>`,
    }
    this.pages.set(pageId, generated)
    return generated
  }
}
