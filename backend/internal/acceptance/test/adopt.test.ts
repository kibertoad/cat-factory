import type { CatFactoryClient } from '@cat-factory/sdk'
import { describe, expect, it, vi } from 'vitest'
import { adoptRepoAsService, findRepo, repoBlocker } from '../src/adopt.ts'
import type { Journal } from '../src/journal.ts'

// The join between a configured repository name and a board service, and every way it can refuse.
//
// Worth its own file because the refusals are the module: `POST /api/v1/services` answers a
// repository it cannot see, one already spoken for on this board, one homed on ANOTHER board and one
// whose linked frame is gone with errors that read alike, and each needs a different fix. They are
// pure reductions over an injected list, so a live pass is not the place to find out one of them
// renders `undefined`.

const repo = (name: string, overrides: Record<string, unknown> = {}) => ({
  owner: 'acme',
  name,
  repoId: 7,
  serviceId: null,
  linkedElsewhere: false,
  monorepo: false,
  private: true,
  provider: 'github',
  defaultBranch: 'main',
  ...overrides,
})

function journal(): Journal {
  return { say: vi.fn(), record: vi.fn() } as unknown as Journal
}

function client(input: {
  repos: Record<string, unknown>[]
  services?: Record<string, unknown>[]
  create?: (body: unknown) => unknown
}) {
  const create = vi.fn(async (body: unknown) => input.create?.(body) ?? { serviceId: 'blk_new' })
  return {
    client: {
      repos: { list: async () => ({ repos: input.repos }) },
      services: { list: async () => ({ services: input.services ?? [] }), create },
    } as unknown as CatFactoryClient,
    create,
  }
}

const options = (over: Record<string, unknown> = {}) => ({
  journal: journal(),
  repoName: 'cf-acc-catalog-api',
  repoOwner: 'acme',
  title: 'cf-acc Catalog API',
  type: 'service' as const,
  description: 'The catalog API.',
  ...over,
})

describe('findRepo', () => {
  it('matches owner and name case-insensitively, as both providers do', () => {
    const repos = [repo('CF-Acc-Catalog-API', { owner: 'ACME' })]
    expect(findRepo(repos, 'acme', 'cf-acc-catalog-api')?.name).toBe('CF-Acc-Catalog-API')
  })

  it('does not match a look-alike under another owner', () => {
    // The reason the owner is part of the match at all: a repository of the same name in someone
    // else's org is a different repository, and adopting it would file this pass's work there.
    expect(
      findRepo(
        [repo('cf-acc-catalog-api', { owner: 'someone-else' })],
        'acme',
        'cf-acc-catalog-api',
      ),
    ).toBeNull()
  })
})

describe('repoBlocker', () => {
  it('reads linkedElsewhere, which serviceId alone cannot state', () => {
    // The contract's own rule: a service homed on another board answers `serviceId: null` WITH the
    // flag, because this workspace-scoped surface has no id to hand back. Reading only the id reads
    // that row as available.
    expect(repoBlocker({ linkedElsewhere: true, monorepo: false })).toBe('linked-elsewhere')
  })

  it('reads monorepo, which backs a service only with a subdirectory', () => {
    expect(repoBlocker({ linkedElsewhere: false, monorepo: true })).toBe('monorepo')
  })

  it('passes a plain unlinked whole repository', () => {
    expect(repoBlocker({ linkedElsewhere: false, monorepo: false })).toBeNull()
  })
})

describe('adoptRepoAsService', () => {
  it('creates a service over a repository nothing holds', async () => {
    const { client: sdk, create } = client({ repos: [repo('cf-acc-catalog-api')] })
    const record = await adoptRepoAsService({ ...options(), client: sdk })
    expect(create).toHaveBeenCalledWith({
      title: 'cf-acc Catalog API',
      type: 'service',
      description: 'The catalog API.',
      repo: { repoId: 7 },
    })
    expect(record).toEqual({
      blockId: 'blk_new',
      serviceId: 'blk_new',
      repoName: 'acme/cf-acc-catalog-api',
    })
  })

  it('reuses the service already backing it rather than raising a second frame', async () => {
    // Idempotent through the PROJECTION, which is what makes it safe to call before consulting the
    // ledger: the repository row names whatever service holds it.
    const { client: sdk, create } = client({
      repos: [repo('cf-acc-catalog-api', { serviceId: 'blk_old' })],
      services: [{ serviceId: 'blk_old', title: 'cf-acc Catalog API' }],
    })
    const record = await adoptRepoAsService({ ...options(), client: sdk })
    expect(create).not.toHaveBeenCalled()
    expect(record.serviceId).toBe('blk_old')
  })

  it('names what the workspace CAN see, since invisible and absent answer identically', async () => {
    // A repository outside a GitHub App's installation is missing from this list exactly as one that
    // was never created is, and the two need opposite fixes.
    const { client: sdk } = client({ repos: [repo('something-else')] })
    await expect(adoptRepoAsService({ ...options(), client: sdk })).rejects.toThrow(
      /Visible to this workspace right now: acme\/something-else/,
    )
  })

  it('points at the wrong-owner case when the name IS visible elsewhere', async () => {
    // The module's stated reason to exist: `ACCEPTANCE_REPO_OWNER` naming the wrong account and the
    // repository having been created under the wrong one are the same symptom.
    const { client: sdk } = client({
      repos: [repo('cf-acc-catalog-api', { owner: 'someone-else' })],
    })
    await expect(adoptRepoAsService({ ...options(), client: sdk })).rejects.toThrow(
      /A repository called 'cf-acc-catalog-api' IS visible under 'someone-else'/,
    )
  })

  it('refuses a repository homed on another board instead of spending a 409 to find out', async () => {
    const { client: sdk, create } = client({
      repos: [repo('cf-acc-catalog-api', { linkedElsewhere: true })],
    })
    await expect(adoptRepoAsService({ ...options(), client: sdk })).rejects.toThrow(
      /repo_service_homed_elsewhere/,
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a monorepo, which backs a service only with a subdirectory', async () => {
    const { client: sdk, create } = client({
      repos: [repo('cf-acc-catalog-api', { monorepo: true })],
    })
    await expect(adoptRepoAsService({ ...options(), client: sdk })).rejects.toThrow(/MONOREPO/)
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a stale link rather than claiming the platform would raise a second frame', async () => {
    // The repository names a service the board no longer lists. Falling through to `services.create`
    // does NOT create a fresh frame: `addServiceFromRepo` finds that same service account-wide and
    // refuses. So the honest move is to say so here, with the remedy, rather than to spend the round
    // trip and surface an opaquer version of it.
    const { client: sdk, create } = client({
      repos: [repo('cf-acc-catalog-api', { serviceId: 'blk_gone' })],
      services: [],
    })
    await expect(adoptRepoAsService({ ...options(), client: sdk })).rejects.toThrow(
      /linked to service blk_gone, which GET \/api\/v1\/services no longer lists/,
    )
    expect(create).not.toHaveBeenCalled()
  })
})
