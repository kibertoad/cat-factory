// Port for talking to a Confluence Cloud site. The worker implements this with a
// `fetch`-based client (Basic auth, no SDK); tests supply a fake returning canned
// page bodies. Credentials are passed per call because they are stored per
// workspace in D1, so a single client instance serves every workspace.

/** Per-workspace Confluence credentials, resolved from the connection record. */
export interface ConfluenceCredentials {
  /** Site base URL, e.g. `https://acme.atlassian.net`. */
  baseUrl: string
  /** Atlassian account email used as the Basic-auth username. */
  email: string
  /** Confluence API token used as the Basic-auth password. */
  apiToken: string
}

/** A page fetched from Confluence, with its raw storage-format body. */
export interface ConfluencePageContent {
  pageId: string
  spaceKey: string
  title: string
  /** Canonical web URL of the page. */
  url: string
  /** Page version number. */
  version: number
  /** Body in Confluence "storage" format (XHTML). */
  body: string
}

export interface ConfluenceClient {
  /** Fetch a single page (with body, space and version) by its numeric id. */
  getPage(creds: ConfluenceCredentials, pageId: string): Promise<ConfluencePageContent>
}
