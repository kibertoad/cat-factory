import type { GitHubRepoRef, GitHubReviewThread } from '@cat-factory/kernel'
import { parseGitHubTime } from './githubHttpHelpers.js'

// The GraphQL half of PR review threads — the reads/writes REST cannot serve: a thread's
// `isResolved` state (the precise "addressed?" signal), a threaded reply, and resolving a thread.
// Extracted from FetchGitHubClient so the client stays a thin transport and this cohesive concern
// lives beside `reviewPosting.ts` (the REST half). Talks to GitHub only through the injected
// `graphql` executor, so it stays runtime-neutral and easy to unit-test.

/**
 * The narrow slice of `FetchGitHubClient.graphql` these helpers need. Deliberately non-generic
 * (the response is narrowed at the one place that knows its shape), so the client can hand over a
 * plain bound delegate — the same shape `reviewPosting.ts` takes for REST.
 */
export type GitHubGraphQlFn = (
  installationId: number,
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>

/** Shape of the `reviewThreads` GraphQL query response (one page). */
interface ReviewThreadsQueryData {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: {
          id: string
          isResolved: boolean
          path: string | null
          line: number | null
          comments?: {
            nodes?: { author?: { login?: string }; body?: string; createdAt?: string }[]
          }
        }[]
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      }
    }
  }
}

/** Page cap for the thread walk — the client's own `MAX_PAGES`, kept local to this concern. */
const MAX_THREAD_PAGES = 10

/**
 * List a PR's review threads (oldest→newest), each with its resolved state, anchor and comments.
 *
 * `comments(last:50)` reads the NEWEST 50 comments per thread (oldest→newest within the window),
 * so the last node is the true latest — the caller derives the thread's isBot/latestCommentAt from
 * it. `first:50` would misclassify a thread with >50 comments (a human re-open as comment #51+
 * would be invisible and a stale bot reply read as "latest"), wrongly dropping a re-opened long
 * thread from the outstanding set.
 */
export async function listPrReviewThreads(
  graphql: GitHubGraphQlFn,
  installationId: number,
  ref: GitHubRepoRef,
  number: number,
): Promise<GitHubReviewThread[]> {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          reviewThreads(first:100,after:$cursor){
            nodes{ id isResolved path line comments(last:50){ nodes{ author{login} body createdAt } } }
            pageInfo{ hasNextPage endCursor }
          }
        }
      }
    }`
  const threads: GitHubReviewThread[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const data = (await graphql(installationId, query, {
      owner: ref.owner,
      repo: ref.repo,
      number,
      cursor,
    })) as ReviewThreadsQueryData
    const conn = data.repository?.pullRequest?.reviewThreads
    for (const node of conn?.nodes ?? []) {
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        path: node.path ?? null,
        line: node.line ?? null,
        comments: (node.comments?.nodes ?? []).map((c) => ({
          author: c.author?.login ?? '',
          body: c.body ?? '',
          createdAt: parseGitHubTime(c.createdAt),
        })),
      })
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break
    cursor = conn.pageInfo.endCursor
  }
  return threads
}

/** Post a threaded reply on an existing review thread (identified by its GraphQL node id). */
export async function replyToPrReviewThread(
  graphql: GitHubGraphQlFn,
  installationId: number,
  threadId: string,
  body: string,
): Promise<void> {
  const mutation = `mutation($threadId:ID!,$body:String!){
      addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){ comment{ id } }
    }`
  await graphql(installationId, mutation, { threadId, body })
}

/** Mark a review thread resolved. */
export async function resolvePrReviewThread(
  graphql: GitHubGraphQlFn,
  installationId: number,
  threadId: string,
): Promise<void> {
  const mutation = `mutation($threadId:ID!){ resolveReviewThread(input:{threadId:$threadId}){ thread{ id } } }`
  await graphql(installationId, mutation, { threadId })
}
