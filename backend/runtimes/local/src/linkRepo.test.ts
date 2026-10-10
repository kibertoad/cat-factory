import { describe, expect, it, vi } from 'vitest'
import { linkRepo } from './linkRepo.js'

// A fake Drizzle chain capturing what `linkRepo` would persist, so the helper's metadata
// fetch + row shaping are covered without a Postgres. The real inserts are exercised
// against Postgres by the conformance/integration runs. Every `select` returns [] so the
// helper takes the "frame has no service yet" branch (insert a fresh service + mount) and
// the account lookup falls back to null — the paths a fresh CLI link exercises.
function fakeDb() {
  const writes: { values: Record<string, unknown> }[] = []
  let deletes = 0
  const insert = (_table: unknown) => ({
    values(values: Record<string, unknown>) {
      const record = () => {
        writes.push({ values })
        return Promise.resolve()
      }
      // Terminal `.values(...)` is awaitable; the conflict variants chain off it.
      return Object.assign(record(), {
        onConflictDoUpdate: record,
        onConflictDoNothing: record,
      })
    },
  })
  const db = {
    insert,
    select(_cols?: unknown) {
      return {
        from(_table: unknown) {
          return {
            where(_predicate: unknown) {
              return { limit: (_n: number) => Promise.resolve([] as unknown[]) }
            },
          }
        },
      }
    },
    update(_table: unknown) {
      return { set: (_v: unknown) => ({ where: (_p: unknown) => Promise.resolve() }) }
    },
    delete(_table: unknown) {
      return {
        where(_predicate: unknown) {
          deletes++
          return Promise.resolve()
        },
      }
    },
  }
  return { db, writes, deletes: () => deletes }
}

describe('linkRepo', () => {
  it('fetches repo metadata with the PAT and seeds installation + repo + service rows', async () => {
    const { db, writes, deletes } = fakeDb()
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

    // Any stale installation row for the workspace (different id) is cleared first.
    expect(deletes()).toBe(1)

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

    // The repo row: no block_id link (removed), attributed as an `'app'`-reachable repo
    // (local mode's shared PAT), keyed to the synthetic installation id.
    const repoRow = writes.map((w) => w.values).find((v) => 'default_branch' in v && 'name' in v)!
    expect('block_id' in repoRow).toBe(false)
    expect(repoRow.linked_via).toBe('app')
    expect(repoRow.github_id).toBe(555)
    expect(repoRow.installation_id).toBe(result.installationId)
    expect(repoRow.private).toBe(1)

    // The frame's Service is bound to the repo — the sole repo↔frame linkage.
    const serviceRow = writes.map((w) => w.values).find((v) => 'frame_block_id' in v)!
    expect(serviceRow.frame_block_id).toBe('blk_frame')
    expect(serviceRow.repo_github_id).toBe(555)
    expect(serviceRow.installation_id).toBe(result.installationId)

    // The installation row.
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
