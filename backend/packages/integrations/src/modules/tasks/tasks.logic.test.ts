import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '@cat-factory/kernel'
import { taskInRepoScope } from './tasks.logic.js'

const scope = { owner: 'octo', repo: 'demo' }

function record(
  source: TaskRecord['source'],
  externalId: string,
): Pick<TaskRecord, 'source' | 'externalId'> {
  return { source, externalId }
}

describe('taskInRepoScope', () => {
  it('keeps a GitHub issue from the scoped repo', () => {
    expect(taskInRepoScope(record('github', 'octo/demo#42'), scope)).toBe(true)
  })

  it('drops a GitHub issue from a sibling repo', () => {
    expect(taskInRepoScope(record('github', 'octo/other#7'), scope)).toBe(false)
    expect(taskInRepoScope(record('github', 'someone/demo#7'), scope)).toBe(false)
  })

  it('matches owner/repo case-insensitively (GitHub names are)', () => {
    expect(taskInRepoScope(record('github', 'Octo/Demo#42'), scope)).toBe(true)
    expect(taskInRepoScope(record('github', 'octo/demo#42'), { owner: 'OCTO', repo: 'DEMO' })).toBe(
      true,
    )
  })

  it('always keeps repo-less sources (Jira, Linear) regardless of scope', () => {
    expect(taskInRepoScope(record('jira', 'PROJ-123'), scope)).toBe(true)
    expect(taskInRepoScope(record('linear', 'ENG-42'), scope)).toBe(true)
  })

  it('treats an unparseable GitHub id as out-of-scope (no leaking into every repo)', () => {
    expect(taskInRepoScope(record('github', 'not-an-id'), scope)).toBe(false)
  })
})
