import type {
  Clock,
  RawWebhookDelivery,
  VcsConnectionRef,
  VcsRepoRef,
  VcsWebhookEvent,
  VcsWebhookMapper,
  WebhookVerifier,
} from '@cat-factory/kernel'
import { checkState, mrState } from './projection.js'

// ---------------------------------------------------------------------------
// GitLab webhook ingest: verification + normalisation.
//
// GitLab does NOT sign the body (no HMAC like GitHub). Instead each webhook carries a
// caller-chosen secret token in the `X-Gitlab-Token` header, compared constant-time
// against the configured secret. The mapper then turns a verified delivery (keyed by the
// `X-Gitlab-Event` name) into a neutral {@link VcsWebhookEvent}.
// ---------------------------------------------------------------------------

/**
 * Verifies the `X-Gitlab-Token` header against the configured secret in constant time.
 * The `WebhookVerifier` port's `verify(rawBody, signatureHeader)` is reused: GitLab passes
 * the token header as `signatureHeader` (the body is irrelevant to GitLab verification).
 */
export class GitLabWebhookVerifier implements WebhookVerifier {
  constructor(private readonly secret: string) {}

  async verify(_rawBody: ArrayBuffer, signatureHeader: string | null): Promise<boolean> {
    if (!signatureHeader || !this.secret) return false
    return constantTimeEqual(signatureHeader, this.secret)
  }
}

type Json = Record<string, unknown>

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null ? (value as Json) : null
}

/** Build the neutral repo ref from a GitLab webhook `project` object. */
function repoRefOf(root: Json): VcsRepoRef | null {
  const project = asObject(root.project)
  if (!project) return null
  const id = project.id
  const pathWithNs =
    typeof project.path_with_namespace === 'string' ? project.path_with_namespace : ''
  const name = pathWithNs.includes('/')
    ? pathWithNs.slice(pathWithNs.lastIndexOf('/') + 1)
    : pathWithNs
  const owner = pathWithNs.includes('/') ? pathWithNs.slice(0, pathWithNs.lastIndexOf('/')) : ''
  return { repoId: id === undefined ? '' : String(id), owner, repo: name }
}

function numericRepoId(repo: VcsRepoRef): number {
  const n = Number(repo.repoId)
  return Number.isInteger(n) ? n : 0
}

export class GitLabWebhookMapper implements VcsWebhookMapper {
  // The clock is injected (rather than `Date.now()`) so projected `updatedAt`/`syncedAt`
  // timestamps are deterministic in tests and consistent with the client's clock.
  constructor(private readonly clock: Clock) {}

  map(connection: VcsConnectionRef, delivery: RawWebhookDelivery): VcsWebhookEvent | null {
    const root = asObject(delivery.payload)
    if (!root) return null
    const repo = repoRefOf(root)
    if (!repo) return null
    const now = this.clock.now()
    const repoId = numericRepoId(repo)

    switch (delivery.eventName) {
      case 'Merge Request Hook': {
        const attrs = asObject(root.object_attributes)
        if (!attrs) return null
        const { state, merged } = mrState(typeof attrs.state === 'string' ? attrs.state : undefined)
        const lastCommit = asObject(attrs.last_commit)
        const author = asObject(asObject(root.user) ? root.user : attrs.author)
        return {
          kind: 'pull-request',
          connection,
          repo,
          pullRequest: {
            repoGithubId: repoId,
            number: num(attrs.iid),
            githubId: num(attrs.id),
            title: str(attrs.title),
            state,
            headRef: str(attrs.source_branch) || null,
            baseRef: str(attrs.target_branch) || null,
            headSha: lastCommit ? str(lastCommit.id) || null : null,
            merged,
            author: author ? str(author.username) || null : null,
            updatedAt: now,
            syncedAt: now,
          },
        }
      }
      case 'Issue Hook': {
        const attrs = asObject(root.object_attributes)
        if (!attrs) return null
        const labels = Array.isArray(root.labels)
          ? (root.labels as Array<{ title?: string }>).map((l) => l.title ?? '').filter(Boolean)
          : []
        const issueAuthor = asObject(root.user)
        return {
          kind: 'issue',
          connection,
          repo,
          issue: {
            repoGithubId: repoId,
            number: num(attrs.iid),
            githubId: num(attrs.id),
            title: str(attrs.title),
            state: str(attrs.state) === 'opened' ? 'open' : 'closed',
            author: issueAuthor ? str(issueAuthor.username) || null : null,
            labels,
            updatedAt: now,
            syncedAt: now,
          },
        }
      }
      case 'Push Hook': {
        const ref = str(root.ref)
        const after = str(root.after)
        const rawCommits = Array.isArray(root.commits) ? (root.commits as Json[]) : []
        return {
          kind: 'push',
          connection,
          repo,
          branch:
            ref.startsWith('refs/heads/') && after
              ? { name: ref.slice('refs/heads/'.length), headSha: after }
              : undefined,
          commits: rawCommits.map((c) => ({
            repoGithubId: repoId,
            sha: str(c.id),
            message: str(c.message),
            author: (() => {
              const a = asObject(c.author)
              return a ? str(a.name) || null : null
            })(),
            authoredAt: (() => {
              const ts = Date.parse(str(c.timestamp))
              return Number.isFinite(ts) ? ts : null
            })(),
            syncedAt: now,
          })),
        }
      }
      case 'Pipeline Hook': {
        const attrs = asObject(root.object_attributes)
        if (!attrs) return null
        const { status, conclusion } = checkState(str(attrs.status))
        return {
          kind: 'ci-status',
          connection,
          repo,
          checkRun: {
            repoGithubId: repoId,
            githubId: num(attrs.id),
            headSha: str(attrs.sha),
            name: 'pipeline',
            status,
            conclusion,
            htmlUrl: str(attrs.url) || null,
            syncedAt: now,
          },
        }
      }
      default:
        return null
    }
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/** Length-aware constant-time string compare (avoids early-exit timing leaks). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
