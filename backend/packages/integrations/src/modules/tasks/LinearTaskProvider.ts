import {
  ValidationError,
  type TaskContent,
  type TaskCredentials,
  type TaskSearchResult,
  type TaskSourceDiagnostic,
  type TaskSourceProvider,
  type NormalizedTaskConnection,
} from '@cat-factory/kernel'
import { LinearApiError, LinearGraphqlClient } from '../shared/linear.client.js'
import {
  LINEAR_ISSUE_QUERY,
  LINEAR_SEARCH_ISSUES_QUERY,
  LINEAR_TASK_DESCRIPTOR,
  LINEAR_VIEWER_QUERY,
  mapLinearIssue,
  mapLinearSearchResults,
  parseLinearRef,
} from './linear.logic.js'

// LinearTaskProvider: the task-source provider for Linear. It authenticates with a
// personal API key against Linear's single GraphQL endpoint (via the shared
// host-pinned, redirect-safe client) and maps an issue onto the structured
// {@link TaskContent} — status / assignee / priority / labels + the Markdown
// description, comments, parent/sub-issues and dependency relations. All
// Linear-specific pure logic (ref parsing, mapping, the GraphQL documents) lives in
// `linear.logic` so it is unit-testable; this class is the thin transport.
//
// Runtime-neutral: it depends only on the kernel ports + the shared client (global
// `fetch`), so the Cloudflare and Node facades compose the SAME class.

export class LinearTaskProvider implements TaskSourceProvider {
  readonly kind = 'linear' as const
  readonly descriptor = LINEAR_TASK_DESCRIPTOR

  normalizeConnection(input: TaskCredentials): NormalizedTaskConnection {
    const apiKey = input.apiKey?.trim()
    if (!apiKey) {
      throw new ValidationError('Linear requires a personal API key')
    }
    return { credentials: { apiKey }, label: 'Linear workspace' }
  }

  parseRef(input: string): string | null {
    return parseLinearRef(input)
  }

  async fetchTask(credentials: TaskCredentials, externalId: string): Promise<TaskContent> {
    const client = new LinearGraphqlClient({ apiKey: credentials.apiKey! })
    const data = await client.query<Parameters<typeof mapLinearIssue>[0]>(LINEAR_ISSUE_QUERY, {
      id: externalId,
    })
    return mapLinearIssue(data)
  }

  async search(credentials: TaskCredentials, query: string): Promise<TaskSearchResult[]> {
    const client = new LinearGraphqlClient({ apiKey: credentials.apiKey! })
    const data = await client.query<Parameters<typeof mapLinearSearchResults>[0]>(
      LINEAR_SEARCH_ISSUES_QUERY,
      { term: query },
    )
    return mapLinearSearchResults(data)
  }

  /**
   * Live setup check: read `viewer` (the cheapest authenticated query) with the
   * stored key. A 401/403 from Linear's GraphQL surfaces as auth_failed/forbidden;
   * a thrown fetch (DNS/network) ⇒ unreachable. Resolves (never rejects), per the port.
   */
  async diagnose(input: {
    workspaceId: string
    credentials: TaskCredentials | null
  }): Promise<TaskSourceDiagnostic> {
    const apiKey = input.credentials?.apiKey
    if (!apiKey) {
      return {
        source: 'linear',
        ok: false,
        status: 'not_connected',
        message: 'Linear has no stored credentials. Connect it with a personal API key.',
      }
    }
    try {
      const client = new LinearGraphqlClient({ apiKey })
      const data = await client.query<{ viewer?: { name?: string } }>(LINEAR_VIEWER_QUERY)
      return {
        source: 'linear',
        ok: true,
        status: 'ready',
        message: 'Authenticated to Linear.',
        detail: data.viewer?.name ? `Signed in as ${data.viewer.name}.` : null,
      }
    } catch (err) {
      if (err instanceof LinearApiError) {
        if (err.status === 401) {
          return {
            source: 'linear',
            ok: false,
            status: 'auth_failed',
            message:
              'Linear rejected the API key (401). Generate a fresh personal API key and reconnect.',
          }
        }
        if (err.status === 403) {
          return {
            source: 'linear',
            ok: false,
            status: 'forbidden',
            message: 'Linear authenticated the key but denied access (403). Check its scopes.',
          }
        }
        return {
          source: 'linear',
          ok: false,
          status: 'error',
          message: err.message,
        }
      }
      return {
        source: 'linear',
        ok: false,
        status: 'unreachable',
        message: "Couldn't reach Linear. Check network connectivity, then re-check.",
      }
    }
  }
}
