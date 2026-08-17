import {
  ConflictError,
  type TaskCredentials,
  type TaskSourceWritebackAdapter,
  type TaskWritebackContext,
} from '@cat-factory/kernel'
import * as atlassianLogic from '../../shared/atlassian.logic.js'
import {
  buildJiraCommentPayload,
  pickTransitionByCategory,
  type JiraTransition,
} from '../../tracker/jira.writeback.logic.js'

// The writeback capability of the Jira task source: comment, resolve (a transition into the
// `done` status category) and claim (a transition into `indeterminate`, Jira's In Progress).
//
// The transport is the same thin `fetch` shell `JiraProvider`'s reads use (the connection's
// stored base URL re-validated on every call, HTTP Basic over account email + API token), and the
// two pure pieces (the ADF comment payload, the category→transition pick) stay in
// `tracker/jira.writeback.logic.ts`, where the ticket-filing path already reads them.
//
// A workspace with no stored Jira credentials REFUSES rather than returning quietly. That is a
// deliberate change from the writeback this replaced, which returned normally in exactly that
// case: the parked-review echo then recorded its idempotency marker for a comment Jira never saw,
// so a linked Jira issue in a workspace whose connection had been removed silently swallowed the
// questions instead of reporting a broken link.

const USER_AGENT = 'cat-factory'

/** Jira Cloud's REST v3 writeback adapter, wired on the provider itself. */
export const jiraWriteback: TaskSourceWritebackAdapter = {
  // HTTP Basic over the connection's stored account email + API token: with no readable bag there
  // is no identity to post as, so an unreadable connection is fatal to every call here.
  authenticates: 'stored-connection',

  async comment(ctx, externalId, body) {
    await jiraRequest(ctx, `issue/${encodeURIComponent(externalId)}/comment`, {
      method: 'POST',
      body: buildJiraCommentPayload(body),
    })
  },

  async resolve(ctx, externalId) {
    await transition(ctx, externalId, 'done')
  },

  /** Jira HAS a workflow status, so the intake mark is a transition and `mark.label` is unused. */
  async markInProgress(ctx, externalId) {
    await transition(ctx, externalId, 'indeterminate')
  },
}

/**
 * Move an issue into a standard status category by listing its available transitions and firing
 * the first one that lands there. A workflow with no such transition available from the issue's
 * current status is a no-op rather than an error: the issue is already past it, or the project's
 * workflow does not offer it to this account, and neither is a delivery failure to report.
 */
async function transition(
  ctx: TaskWritebackContext,
  externalId: string,
  category: 'indeterminate' | 'done',
): Promise<void> {
  const path = `issue/${encodeURIComponent(externalId)}/transitions`
  const list = (await jiraRequest(ctx, path, { method: 'GET' })) as {
    transitions?: JiraTransition[]
  } | null
  const chosen = pickTransitionByCategory(list?.transitions ?? [], category)
  if (!chosen?.id) return
  await jiraRequest(ctx, path, { method: 'POST', body: { transition: { id: chosen.id } } })
}

/**
 * One authenticated Jira REST v3 request for the workspace's connection. Throws on a non-OK
 * status so the caller's per-issue isolation reports it (and so the question echo never records a
 * failed post as delivered).
 */
async function jiraRequest(
  ctx: TaskWritebackContext,
  path: string,
  init: { method: string; body?: unknown },
): Promise<unknown> {
  const { baseUrl, accountEmail, apiToken } = requireJiraCredentials(ctx.credentials)
  const base = baseUrl.replace(/\/+$/, '')
  // Re-validate the stored base before fetching with the workspace's credentials, exactly as the
  // read path does: a base that became unsafe since connect time must not be reached now.
  atlassianLogic.assertSafeAtlassianBaseUrl(base)
  const url = `${base}/rest/api/3/${path}`
  const auth = btoa(`${accountEmail}:${apiToken}`)
  const res = await fetch(url, {
    method: init.method,
    headers: {
      authorization: `Basic ${auth}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    // Omit the body entirely for a bodyless (GET) request: `fetch` throws for ANY non-null body
    // on a GET, including an empty string, which would surface as a transport failure.
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Jira ${init.method} ${url} → ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json().catch(() => null)
}

/** The three fields a Jira write needs, or a refusal naming what the workspace is missing. */
function requireJiraCredentials(credentials: TaskCredentials): {
  baseUrl: string
  accountEmail: string
  apiToken: string
} {
  const { baseUrl, accountEmail, apiToken } = credentials
  if (!baseUrl || !accountEmail || !apiToken) {
    throw new ConflictError(
      'This workspace has no Jira connection, so its linked Jira issues cannot be written back to.',
    )
  }
  return { baseUrl, accountEmail, apiToken }
}
