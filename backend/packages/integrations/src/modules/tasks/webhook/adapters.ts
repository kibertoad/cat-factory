import type {
  TaskSourceWebhookAdapter,
  TrackerCommentAuthor,
  TrackerIssueEvent,
} from '@cat-factory/kernel'
import { githubIssueExternalId } from '../github-issues.logic.js'
import { parseGitLabIssueRef } from '../gitlab-issues.logic.js'
import { adfToMarkdown } from '../jira.logic.js'
import {
  parseJsonBody,
  readObject,
  readString,
  verifyHmacSignature,
  verifySharedToken,
} from './hmac.js'

// The per-vendor half of tracker webhook ingest: verify a delivery's signature and map its
// payload onto the neutral `TrackerWebhookEvent`. Everything transport-shaped (raw body, fast
// ack, hand-off to the facade's queue) lives in the shared receiver; everything vendor-shaped
// lives here, exactly as `@cat-factory/gitlab`'s webhook mapper owns GitLab's.
//
// Two rules apply to every adapter below:
//
//  - **`parse` never throws.** A tracker sends far more event kinds than we consume, and several
//    send outright unrelated shapes (Jira's `jira:issue_updated` for a sprint field, Linear's
//    `Reaction`). An unrecognised delivery maps to `null`, which the receiver ACKS — retrying it
//    would just make the vendor redeliver a shape we will never act on.
//  - **`parse` reads defensively.** The payload is attacker-influenced up to the point the
//    signature proves it came from the vendor, and vendor-shaped-but-partial after; every read
//    goes through the `readString`/`readObject` helpers rather than a cast.

/** GitHub App deliveries: HMAC-SHA256 hex in `X-Hub-Signature-256`, prefixed `sha256=`. */
const GITHUB_SCHEME = { header: 'x-hub-signature-256', prefix: 'sha256=' }

/** Jira Cloud webhook deliveries: HMAC-SHA256 hex in `X-Hub-Signature`, prefixed `sha256=`. */
const JIRA_SCHEME = { header: 'x-hub-signature', prefix: 'sha256=' }

/** Linear deliveries: bare HMAC-SHA256 hex in `Linear-Signature` (no scheme prefix). */
const LINEAR_SCHEME = { header: 'linear-signature', prefix: '' }

/** GitLab deliveries: the shared secret itself, echoed in `X-Gitlab-Token` (no signature). */
const GITLAB_TOKEN_HEADER = 'x-gitlab-token'

/**
 * GitHub Issues.
 *
 * NOTE the deliberate scope: only `issues` and `issue_comment` are consumed. A `pull_request`
 * delivery is a VCS concern that already rides `/github/webhooks` — routing it here too would
 * double-project it.
 *
 * GitHub also sends `issue_comment` for comments on PULL REQUESTS, and those are mapped here like
 * any other. That is harmless rather than wrong: issues and PRs share one number space per repo,
 * so a PR comment's `externalId` can never collide with a real issue's, and it simply finds no
 * linked task and is ignored. The practical consequence is that a reply command typed on a PR does
 * nothing — the loop is anchored to the issue the work was requested on.
 */
export const githubIssuesWebhookAdapter: TaskSourceWebhookAdapter = {
  verify: (secret, delivery) =>
    verifyHmacSignature(secret, delivery.raw, delivery.headers, GITHUB_SCHEME),
  parse(delivery) {
    const payload = parseJsonBody(delivery.raw)
    if (!payload) return null
    const repo = readString(payload, 'repository', 'full_name')
    const number = readString(payload, 'issue', 'number')
    if (!repo || !number) return null
    const [owner, name] = repo.split('/')
    if (!owner || !name) return null
    const externalId = githubIssueExternalId({ owner, repo: name, number: Number(number) })

    if (delivery.eventName === 'issue_comment') {
      // `deleted` carries a comment we must not act on, and `edited` would re-apply an already
      // ingested command under a new body — the claim is keyed by comment id, so an edit would
      // be a legitimate second apply we do not want. Only a fresh comment drives the loop.
      if (readString(payload, 'action') !== 'created') return null
      const commentId = readString(payload, 'comment', 'id')
      const body = readString(payload, 'comment', 'body')
      if (!commentId || !body) return null
      return {
        kind: 'comment',
        source: 'github',
        externalId,
        commentId,
        body,
        author: githubAuthor(readObject(payload, 'comment', 'user')),
      }
    }

    if (delivery.eventName === 'issues') {
      const action = readString(payload, 'action')
      if (!action) return null
      return {
        kind: 'issue',
        source: 'github',
        externalId,
        action: githubIssueAction(action),
        title: readString(payload, 'issue', 'title') ?? '',
        labels: readNameList(payload, 'issue', 'labels'),
        issueType: readString(payload, 'issue', 'type', 'name'),
        // The `owner/name` slug is exactly what `IssueIntakeQuery.board.githubRepo` carries, and
        // it is already parsed above for the external id.
        board: repo,
        url: readString(payload, 'issue', 'html_url'),
      }
    }
    return null
  },
}

/**
 * Jira Cloud.
 *
 * Jira routes everything through `webhookEvent` in the BODY rather than a header, so the
 * delivery's `eventName` is ignored here. Its label/type fields live under `issue.fields`.
 */
export const jiraWebhookAdapter: TaskSourceWebhookAdapter = {
  verify: (secret, delivery) =>
    verifyHmacSignature(secret, delivery.raw, delivery.headers, JIRA_SCHEME),
  parse(delivery) {
    const payload = parseJsonBody(delivery.raw)
    if (!payload) return null
    const event = readString(payload, 'webhookEvent') ?? ''
    // Jira's key is the canonical external id, upper-cased exactly as `parseJiraRef` yields it,
    // so the projection lookup matches an issue imported by paste or by search.
    const externalId = readString(payload, 'issue', 'key')?.toUpperCase()
    if (!externalId) return null

    if (event === 'comment_created') {
      const comment = readObject(payload, 'comment')
      const commentId = readString(comment, 'id')
      // Jira Cloud v3 comments are ADF: `body` is a document object, and only an older site (or a
      // v2 REST client) sends a plain string. Reading it with `readString` alone therefore dropped
      // every rich-text reply on the floor, silently, since an unparsed delivery is ACKED, so a
      // reporter who answered a clarification question in Jira's own editor got no answer recorded
      // and no acknowledgement telling them so.
      //
      // The normalisation is the IMPORT path's own `adfToMarkdown`, imported rather than
      // re-derived: a second traversal here is exactly the drifting copy the previous note was
      // right to refuse. `adfToMarkdown` already passes a plain string straight through, so it
      // covers both shapes, and it preserves the line structure the reply grammar reads (a
      // command counts only as the first token of a line).
      const body = adfToMarkdown(readObject(comment, 'body') ?? readString(comment, 'body'))
      if (!commentId || !body) return null
      return {
        kind: 'comment',
        source: 'jira',
        externalId,
        commentId,
        body,
        author: jiraAuthor(readObject(comment, 'author')),
      }
    }

    if (event === 'jira:issue_created' || event === 'jira:issue_updated') {
      const fields = readObject(payload, 'issue', 'fields')
      const statusCategory = readString(fields, 'status', 'statusCategory', 'key')
      return {
        kind: 'issue',
        source: 'jira',
        externalId,
        action:
          event === 'jira:issue_created'
            ? 'created'
            : statusCategory === 'done'
              ? 'closed'
              : 'updated',
        title: readString(fields, 'summary') ?? '',
        labels: readStringList(fields, 'labels'),
        issueType: readString(fields, 'issuetype', 'name'),
        // The project KEY, not its numeric id: `IssueIntakeQuery.board.jiraProjectKey` is what a
        // schedule stores and what `listBoards` hands back, and JQL scopes on the key.
        board: readString(fields, 'project', 'key')?.toUpperCase() ?? null,
        url: readString(payload, 'issue', 'self'),
      }
    }
    return null
  },
}

/**
 * Linear.
 *
 * Linear's `Comment` payload carries the issue's human identifier under `data.issue.identifier`
 * — which is what {@link parseLinearRef} yields and therefore what the projection is keyed by.
 * The raw `data.issue.id` is a UUID and would never match an imported row.
 */
export const linearWebhookAdapter: TaskSourceWebhookAdapter = {
  verify: (secret, delivery) =>
    verifyHmacSignature(secret, delivery.raw, delivery.headers, LINEAR_SCHEME),
  parse(delivery) {
    const payload = parseJsonBody(delivery.raw)
    if (!payload) return null
    const type = readString(payload, 'type')
    const action = readString(payload, 'action')
    const data = readObject(payload, 'data')

    if (type === 'Comment') {
      if (action !== 'create') return null
      const externalId = readString(data, 'issue', 'identifier')?.toUpperCase()
      const commentId = readString(data, 'id')
      const body = readString(data, 'body')
      if (!externalId || !commentId || !body) return null
      return {
        kind: 'comment',
        source: 'linear',
        externalId,
        commentId,
        body,
        author: linearAuthor(readObject(data, 'user')),
      }
    }

    if (type === 'Issue') {
      const externalId = readString(data, 'identifier')?.toUpperCase()
      if (!externalId || (action !== 'create' && action !== 'update')) return null
      return {
        kind: 'issue',
        source: 'linear',
        externalId,
        action:
          action === 'create'
            ? 'created'
            : readString(data, 'state', 'type') === 'completed'
              ? 'closed'
              : 'updated',
        title: readString(data, 'title') ?? '',
        labels: readNameList(data, 'labels'),
        // Linear has no issue-type notion; intake's `issueType` predicate is a no-op here, the
        // same way `searchIssues` ignores it for this source.
        issueType: null,
        // The team UUID, which is what `buildLinearIntakeFilter` matches on (`team.id.eq`) and
        // what `listTeams` hands the board picker, never the human team KEY, which would look
        // plausible and never match. Linear sends the nested team on most Issue payloads and a
        // bare `teamId` on the leaner ones.
        board: readString(data, 'team', 'id') ?? readString(data, 'teamId'),
        url: readString(data, 'url'),
      }
    }
    return null
  },
}

/**
 * GitLab.
 *
 * Two differences from the three above, both load-bearing:
 *
 *  - **There is no signature.** GitLab echoes the caller-chosen secret in `X-Gitlab-Token`, so
 *    verification is a constant-time compare of that header (see {@link verifySharedToken}).
 *  - **The payload is keyed by `object_kind` in the BODY**, like Jira's `webhookEvent`, so the
 *    delivery's `eventName` header is ignored here.
 *
 * The external id is built through {@link parseGitLabIssueRef} rather than concatenated, so a
 * project path the id grammar cannot express (one GitLab would serve but our parser does not
 * admit) maps to `null` (an unrecognised delivery, which the receiver acks) instead of minting an id that no
 * imported row can ever match.
 */
export const gitlabIssuesWebhookAdapter: TaskSourceWebhookAdapter = {
  verify: async (secret, delivery) =>
    verifySharedToken(secret, delivery.headers, GITLAB_TOKEN_HEADER),
  parse(delivery) {
    const payload = parseJsonBody(delivery.raw)
    if (!payload) return null
    const project = readString(payload, 'project', 'path_with_namespace')
    if (!project) return null
    const kind = readString(payload, 'object_kind')

    if (kind === 'note') {
      // Notes cover merge requests, commits and snippets too; only an issue note drives the loop.
      // (A reply command typed on an MR therefore does nothing, exactly as on GitHub, where the
      // shared issue/PR number space makes the same comment simply find no linked task.)
      if (readString(payload, 'object_attributes', 'noteable_type') !== 'Issue') return null
      const externalId = gitlabExternalId(project, readString(payload, 'issue', 'iid'))
      const commentId = readString(payload, 'object_attributes', 'id')
      const body = readString(payload, 'object_attributes', 'note')
      if (!externalId || !commentId || !body) return null
      return {
        kind: 'comment',
        source: 'gitlab',
        externalId,
        commentId,
        body,
        author: gitlabAuthor(readObject(payload, 'user')),
      }
    }

    if (kind === 'issue') {
      const attrs = readObject(payload, 'object_attributes')
      const externalId = gitlabExternalId(project, readString(attrs, 'iid'))
      if (!externalId) return null
      return {
        kind: 'issue',
        source: 'gitlab',
        externalId,
        action: gitlabIssueAction(readString(attrs, 'action'), readString(attrs, 'state')),
        title: readString(attrs, 'title') ?? '',
        // GitLab labels carry `title`, not the `name` the other three read. Both the
        // top-level list and the one nested on the issue are sent depending on the instance's
        // version, so read whichever is populated rather than picking one and reporting an
        // unlabelled issue (which an intake label predicate would read as `unconfirmed`).
        labels: readTitleList(payload, 'labels').length
          ? readTitleList(payload, 'labels')
          : readTitleList(attrs, 'labels'),
        // GitLab's issue TYPE vocabulary (`issue`/`incident`/`test_case`/`task`) has no member
        // meaning "bug", which is why `GitLabIssuesProvider` declares `issueType` among its
        // `ignoredIntakePredicates` and omits it from the vendor query. Reporting the payload's
        // type here would make the push path evaluate a predicate the polling path ignores, so
        // the same delivery would be admitted by a schedule fire and refused by a webhook.
        issueType: null,
        // The full path with namespace, exactly what `IssueIntakeQuery.board.gitlabProject`
        // carries and what `listBoards` hands the picker.
        board: project,
        url: readString(attrs, 'url'),
      }
    }
    return null
  },
}

/**
 * The canonical `group/sub/project#iid` id for a delivery's project path + issue iid, or null when
 * either is missing or the pair does not parse as a reference we could have imported.
 */
function gitlabExternalId(project: string, iid: string | null): string | null {
  if (!iid) return null
  return parseGitLabIssueRef(`${project}#${iid}`)
}

/** GitLab's issue actions collapsed onto the neutral lifecycle triple. */
function gitlabIssueAction(
  action: string | null,
  state: string | null,
): TrackerIssueEvent['action'] {
  if (action === 'open') return 'created'
  // `close` is the explicit action; the state check catches an `update` delivered for an issue
  // that is already closed, which must not be re-offered to intake as live work.
  if (action === 'close' || state === 'closed') return 'closed'
  return 'updated'
}

function gitlabAuthor(user: Record<string, unknown> | null): TrackerCommentAuthor {
  return {
    id: readString(user, 'id'),
    handle: readString(user, 'username') ?? readString(user, 'name'),
    email: readString(user, 'email'),
    // GitLab's webhook `user` object carries no bot flag, so an integration's own notes are
    // caught by the identity allow-list rather than here, and reported honestly as `false` instead
    // of guessed at from the username, exactly as on Linear.
    bot: false,
  }
}

/** Read a list of `{ title }` objects (GitLab labels) as plain names. */
function readTitleList(payload: unknown, ...path: string[]): string[] {
  const list = readList(payload, path)
  return list.map((entry) => readString(entry, 'title')).filter((v): v is string => v != null)
}

/** GitHub's issue actions collapsed onto the neutral lifecycle triple. */
function githubIssueAction(action: string): TrackerIssueEvent['action'] {
  if (action === 'opened') return 'created'
  if (action === 'closed') return 'closed'
  // `labeled`/`unlabeled`/`edited`/`typed`/`reopened`/`transferred` all mean "the issue changed";
  // intake re-evaluates the predicates against the payload regardless of WHICH field moved, so
  // collapsing them keeps the neutral event honest instead of inventing a per-vendor taxonomy.
  return 'updated'
}

function githubAuthor(user: Record<string, unknown> | null): TrackerCommentAuthor {
  return {
    id: readString(user, 'node_id'),
    handle: readString(user, 'login'),
    email: null,
    // GitHub marks Apps (and the platform's own App comments) with `type: 'Bot'`.
    bot: readString(user, 'type') === 'Bot',
  }
}

function jiraAuthor(author: Record<string, unknown> | null): TrackerCommentAuthor {
  return {
    id: readString(author, 'accountId'),
    handle: readString(author, 'displayName'),
    email: readString(author, 'emailAddress'),
    bot: readString(author, 'accountType') === 'app',
  }
}

function linearAuthor(user: Record<string, unknown> | null): TrackerCommentAuthor {
  return {
    id: readString(user, 'id'),
    handle: readString(user, 'name') ?? readString(user, 'displayName'),
    email: readString(user, 'email'),
    // Linear does not flag bots on the comment author, so an integration's own comments are
    // caught by the identity allow-list rather than here. Reported honestly as `false` instead of
    // guessed at from the name.
    bot: false,
  }
}

/** Read a list of `{ name }` objects (GitHub/Linear labels) as plain names. */
function readNameList(payload: unknown, ...path: string[]): string[] {
  const list = readList(payload, path)
  return list.map((entry) => readString(entry, 'name')).filter((v): v is string => v != null)
}

/** Read a list of plain strings (Jira labels). */
function readStringList(payload: unknown, ...path: string[]): string[] {
  return readList(payload, path).filter((v): v is string => typeof v === 'string')
}

function readList(payload: unknown, path: string[]): unknown[] {
  let cursor: unknown = payload
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return []
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return Array.isArray(cursor) ? cursor : []
}
