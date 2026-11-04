import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskWritebackContext } from '@cat-factory/kernel'
import { linearWriteback } from './linear.writeback.js'

// The Linear writeback transport. Every write is a lookup then a mutation, because Linear's
// mutations take the issue UUID while the stored external id is the human identifier, and both
// state changes are transitions to a workflow state of a standard TYPE (Linear has no close).

const CTX = createTaskWritebackContext({
  workspaceId: 'ws_1',
  credentials: { apiKey: 'lin_api_x' },
})

interface Operation {
  name: string
  variables: Record<string, unknown>
}

/** Stub the global `fetch` with a Linear GraphQL endpoint, recording each operation. */
function stubLinear(
  states: { id: string; type: string }[] = [
    { id: 'st-progress', type: 'started' },
    { id: 'st-done', type: 'completed' },
  ],
  issueId: string | null = 'uuid-1',
): Operation[] {
  const operations: Operation[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    const parsed = JSON.parse(init.body ?? '{}') as {
      query: string
      variables: Record<string, unknown>
    }
    // A REAL `Response`: the shared Linear client reads the body as a capped stream (it pins the
    // host and bounds the payload), which a plain `{ json() }` literal cannot satisfy.
    const answer = (name: string, data: unknown) => {
      operations.push({ name, variables: parsed.variables })
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (parsed.query.includes('IssueResolveLookup')) {
      return answer('resolve-lookup', {
        issue: issueId ? { id: issueId, team: { states: { nodes: states } } } : null,
      })
    }
    if (parsed.query.includes('IssueId')) {
      return answer('id-lookup', { issue: issueId ? { id: issueId } : null })
    }
    if (parsed.query.includes('CommentCreate')) {
      return answer('comment', { commentCreate: { success: true } })
    }
    if (parsed.query.includes('IssueUpdate')) {
      return answer('update', { issueUpdate: { success: true } })
    }
    throw new Error(`unexpected query: ${parsed.query}`)
  })
  return operations
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('linearWriteback', () => {
  it('resolves the identifier to a UUID before creating the comment', async () => {
    const operations = stubLinear()
    await linearWriteback.comment(CTX, 'ENG-1', 'hello')
    expect(operations.map((o) => o.name)).toEqual(['id-lookup', 'comment'])
    expect((operations[1]!.variables.input as { issueId: string }).issueId).toBe('uuid-1')
  })

  it('transitions to the COMPLETED state on resolve and the STARTED one on claim', async () => {
    const resolveOps = stubLinear()
    await linearWriteback.resolve!(CTX, 'ENG-1')
    expect((resolveOps.at(-1)!.variables.input as { stateId: string }).stateId).toBe('st-done')

    vi.unstubAllGlobals()
    const claimOps = stubLinear()
    await linearWriteback.markInProgress!(CTX, 'ENG-1', {})
    expect((claimOps.at(-1)!.variables.input as { stateId: string }).stateId).toBe('st-progress')
  })

  it('leaves the issue alone when the team workflow has no state of that type', async () => {
    // Nothing to move to is a no-op, not a failure: the workflow cannot express the step.
    const operations = stubLinear([{ id: 'st-todo', type: 'unstarted' }])
    await linearWriteback.resolve!(CTX, 'ENG-1')
    expect(operations.map((o) => o.name)).toEqual(['resolve-lookup'])
  })

  it('THROWS when the connection cannot see the issue at all', async () => {
    // The opposite disposition from the workflow gap above: this is the broken link a silent
    // return would hide from a caller that is recording whether the comment landed.
    stubLinear([], null)
    await expect(linearWriteback.comment(CTX, 'ENG-1', 'hi')).rejects.toThrow(/not readable/)
  })

  it('REFUSES a workspace with neither an OAuth token nor an API key', async () => {
    const operations = stubLinear()
    await expect(
      linearWriteback.comment(
        createTaskWritebackContext({ workspaceId: 'ws_1', credentials: {} }),
        'ENG-1',
        'hi',
      ),
    ).rejects.toThrow(/neither an OAuth token nor an API key/)
    expect(operations).toEqual([])
  })
})

describe('linearWriteback.replaceDescription', () => {
  /** Stub Linear answering the description lookup with `stored`. */
  function stubDescription(stored: string | null): Operation[] {
    const operations: Operation[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
      const parsed = JSON.parse(init.body ?? '{}') as {
        query: string
        variables: Record<string, unknown>
      }
      const name = parsed.query.includes('IssueDescription') ? 'lookup' : 'update'
      operations.push({ name, variables: parsed.variables })
      const data =
        name === 'lookup'
          ? { issue: { id: 'uuid-1', description: stored } }
          : { issueUpdate: { success: true } }
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    return operations
  }

  it('updates the Markdown description by the issue UUID when it differs', async () => {
    const operations = stubDescription('old text')
    expect(await linearWriteback.replaceDescription!(CTX, 'ENG-1', 'new text')).toBe('updated')
    expect(operations).toEqual([
      { name: 'lookup', variables: { id: 'ENG-1' } },
      { name: 'update', variables: { id: 'uuid-1', input: { description: 'new text' } } },
    ])
  })

  it('leaves a description that already holds the body alone', async () => {
    const operations = stubDescription('new text\r\n')
    expect(await linearWriteback.replaceDescription!(CTX, 'ENG-1', 'new text')).toBe('unchanged')
    expect(operations.map((op) => op.name)).toEqual(['lookup'])
  })
})
