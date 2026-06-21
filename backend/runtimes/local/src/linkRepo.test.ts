import { describe, expect, it, vi } from 'vitest'
import { linkRepo } from './linkRepo.js'

// A fake Drizzle insert chain capturing what `linkRepo` would persist, so the helper's
// metadata fetch + row shaping are covered without a Postgres. The real inserts are
// exercised against Postgres by the conformance/integration runs.
function fakeDb() {
  const writes: { table: string; values: Record<string, unknown> }[] = []
  const db = {
    insert(table: { tableName: string } | unknown) {
      // drizzle pg tables expose their name via a symbol; tests don't need it precisely,
      // so distinguish by the values' columns instead (installation vs repo).
      void table
      return {
        values(values: Record<string, unknown>) {
          return {
            onConflictDoUpdate() {
              writes.push({
                table: 'installation_id' in values ? 'repo-or-install' : 'unknown',
                values,
              })
              return Promise.resolve()
            },
          }
        },
      }
    },
  }
  return { db, writes }
}

describe('linkRepo', () => {
  it('fetches repo metadata with the PAT and seeds installation + repo rows', async () => {
    const { db, writes } = fakeDb()
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: 555,
            default_branch: 'trunk',
            private: true,
            owner: { id: 42, login: 'acme', type: 'Organization' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const result = await linkRepo({
      workspaceId: 'ws_1',
      frameBlockId: 'blk_frame',
      repo: 'acme/widgets',
      pat: 'pat_x',
      db: db as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('https://api.github.com/repos/acme/widgets')
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      authorization: 'Bearer pat_x',
    })

    expect(result.owner).toBe('acme')
    expect(result.name).toBe('widgets')
    expect(result.githubId).toBe(555)
    expect(result.defaultBranch).toBe('trunk')
    expect(result.private).toBe(true)

    // Two rows written: a github_installations row and a github_repos row, both keyed to
    // the same synthetic installation id, with the repo linked to the frame block.
    expect(writes).toHaveLength(2)
    const repoRow = writes.map((w) => w.values).find((v) => 'block_id' in v)!
    expect(repoRow.block_id).toBe('blk_frame')
    expect(repoRow.github_id).toBe(555)
    expect(repoRow.installation_id).toBe(result.installationId)
    expect(repoRow.private).toBe(1)
    const installRow = writes.map((w) => w.values).find((v) => 'account_login' in v)!
    expect(installRow.workspace_id).toBe('ws_1')
    expect(installRow.account_login).toBe('acme')
    expect(installRow.target_type).toBe('Organization')
  })

  it('rejects a malformed repo and a missing PAT', async () => {
    await expect(
      linkRepo({ workspaceId: 'w', frameBlockId: 'b', repo: 'nope', pat: 'x', db: {} as never }),
    ).rejects.toThrow(/owner\/name/)
    await expect(
      linkRepo({
        workspaceId: 'w',
        frameBlockId: 'b',
        repo: 'a/b',
        pat: '',
        env: {},
        db: {} as never,
      }),
    ).rejects.toThrow(/PAT is required/)
  })

  it('surfaces a GitHub API error', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    await expect(
      linkRepo({
        workspaceId: 'w',
        frameBlockId: 'b',
        repo: 'a/b',
        pat: 'x',
        db: {} as never,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 404/)
  })
})
