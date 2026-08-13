import type { BugCandidate, GitHubIssueSearchHit, TaskSourceKind } from '@cat-factory/kernel'
import { MAX_CANDIDATE_DESCRIPTION_CHARS } from './tasks.logic.js'

// The projections every REPO-BACKED issue source shares (today GitHub Issues and GitLab Issues).
//
// The two sources differ in the things a vendor makes different: the external-id grammar, whose
// case comparison is authoritative, whether a namespace nests, what a predicate compiles to. Each
// of those lives in that source's own `*-issues.logic.ts` and is documented there.
//
// What is HERE is what has no vendor in it. A hunt candidate is a shape the PLATFORM defined,
// built from fields both vendors already normalise into `GitHubIssueSearchHit`, so a second copy
// per source is not a place where a difference is expressed: it is a place where a difference can
// appear by accident, in the rows the ranking model then rates as if both sources had described
// their issues the same way.

/**
 * Build a repo-backed source's search-hit → {@link BugCandidate} mapper.
 *
 * `priority` and `type` are left EMPTY rather than guessed, on both sources and for the same
 * reason: neither vendor's issue search carries a field for them. GitHub org issue types and
 * GitLab's `type::`/`priority::` scoped labels are per-installation conventions, so reading one
 * deployment's convention onto every one of them would report a priority nobody set. The labels
 * ride along, so a ranking still sees whatever convention a board does use.
 */
export function repoIssueBugCandidateMapper(
  source: TaskSourceKind,
  externalId: (hit: GitHubIssueSearchHit) => string,
): (hit: GitHubIssueSearchHit) => BugCandidate {
  return (hit) => ({
    source,
    externalId: externalId(hit),
    title: hit.title,
    url: hit.url,
    status: hit.state,
    type: '',
    priority: null,
    labels: hit.labels ?? [],
    description: (hit.body ?? '').trim().slice(0, MAX_CANDIDATE_DESCRIPTION_CHARS),
    createdAt: hit.createdAt ?? '',
    commentCount: hit.commentCount ?? 0,
  })
}
