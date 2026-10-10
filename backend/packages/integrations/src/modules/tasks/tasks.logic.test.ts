import { describe, expect, it } from 'vitest'
import type { TaskRecord, TaskSourceProvider } from '@cat-factory/kernel'
import { taskInRepoScope } from './tasks.logic.js'

const scope = { owner: 'octo', repo: 'demo' }

function record(
  source: TaskRecord['source'],
  externalId: string,
): Pick<TaskRecord, 'source' | 'externalId'> {
  return { source, externalId }
}

/** A provider stub carrying only what the scope filter reads. */
function provider(repoScope?: TaskSourceProvider['repoScope']): TaskSourceProvider {
  return { repoScope } as TaskSourceProvider
}

// What this file pins is the DELEGATION: which sources are narrowed, and to whose rule. The
// rules themselves (GitHub's case-insensitive owner/repo, GitLab's case-sensitive nested path)
// are each source's own, and are covered in that source's logic test.
describe('taskInRepoScope', () => {
  it('asks a repo-backed source its own rule, and honours the verdict', () => {
    const seen: Array<[string, typeof scope]> = []
    const repoBacked = provider({
      matches: (externalId, s) => {
        seen.push([externalId, s])
        return externalId === 'octo/demo#42'
      },
    })
    expect(taskInRepoScope(record('github', 'octo/demo#42'), scope, repoBacked)).toBe(true)
    expect(taskInRepoScope(record('github', 'octo/other#7'), scope, repoBacked)).toBe(false)
    expect(seen).toEqual([
      ['octo/demo#42', scope],
      ['octo/other#7', scope],
    ])
  })

  it('keeps every row of a repo-less source (Jira, Linear declare no repoScope)', () => {
    expect(taskInRepoScope(record('jira', 'PROJ-123'), scope, provider())).toBe(true)
    expect(taskInRepoScope(record('linear', 'ENG-42'), scope, provider())).toBe(true)
  })

  it('keeps a row whose source is no longer registered, rather than judging it unseen', () => {
    // A scope that cannot be evaluated must not read to the user as "this service has no such
    // issue"; dropping the row would shrink the list rather than narrow it.
    expect(taskInRepoScope(record('acme:servicenow', 'INC0042'), scope, undefined)).toBe(true)
  })
})
