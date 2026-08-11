import { CatFactoryNotFoundError, type CatFactoryClient } from '@cat-factory/sdk'
import { describe, expect, it, vi } from 'vitest'
import { adoptRepoAsService, findRepo, isRepoUnreachable, repoBlocker } from '../src/adopt.ts'
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

/**
 * A deployment whose `repos.list` holds `repos`, and whose ADOPT answers with `link`.
 *
 * The adopt is its own knob because it is the module's first call for a repository the workspace has
 * not linked: `undefined` means "reachable, and here is the row" (the ordinary case), and a test that
 * wants the refusal passes the 404 the surface documents.
 */
function client(input: {
  repos: Record<string, unknown>[]
  services?: Record<string, unknown>[]
  create?: (body: unknown) => unknown
  link?: () => unknown
}) {
  const create = vi.fn(async (body: unknown) => input.create?.(body) ?? { serviceId: 'blk_new' })
  const link = vi.fn(async () => input.link?.() ?? repo('cf-acc-catalog-api'))
  return {
    client: {
      repos: { list: async () => ({ repos: input.repos }), link },
      services: { list: async () => ({ services: input.services ?? [] }), create },
    } as unknown as CatFactoryClient,
    create,
    link,
  }
}

/** The 404 the adopt turns into instructions, as the SDK raises it. */
function notReachable(): CatFactoryNotFoundError {
  return new CatFactoryNotFoundError({
    status: 404,
    code: 'not_found',
    message: "repository 'acme/cf-acc-catalog-api' not found",
    details: { reason: 'repo_not_reachable' },
    requestId: 'req_1',
    body: {},
  })
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

  it('ADOPTS a repository the workspace has not linked, rather than refusing', async () => {
    // The state a hand-written `.env` starts in, and the reason this module calls the link endpoint:
    // `GET /api/v1/repos` lists what is LINKED, so a reachable repository nobody has adopted is absent
    // from it, and refusing there would make `configure` the only supported way in.
    const { client: sdk, link, create } = client({ repos: [] })
    const record = await adoptRepoAsService({ ...options(), client: sdk })
    expect(link).toHaveBeenCalledWith({ owner: 'acme', name: 'cf-acc-catalog-api' })
    expect(create).toHaveBeenCalled()
    expect(record.repoName).toBe('acme/cf-acc-catalog-api')
  })

  it('asks for creation and access, never for linking, when the adopt cannot reach it', async () => {
    // The one refusal left, and the steps cover only what no API can do for an operator. A remedy
    // telling someone to open the app's repository picker would ask for the step this module performs.
    const { client: sdk } = client({
      repos: [],
      link: () => {
        throw notReachable()
      },
    })
    await expect(adoptRepoAsService({ ...options(), client: sdk })).rejects.toThrow(
      /could not reach 'acme\/cf-acc-catalog-api' \(404 repo_not_reachable\)/,
    )
    await expect(adoptRepoAsService({ ...options(), client: sdk })).rejects.toThrow(
      /does not exist yet, create it EMPTY except for a README/,
    )
    await expect(adoptRepoAsService({ ...options(), client: sdk })).rejects.not.toThrow(
      /Manage repos/,
    )
  })

  it('lets a failure that is NOT the documented 404 propagate untouched', async () => {
    // A 503 from an unwired module and a 500 from a provider outage are facts about the deployment,
    // and dressing either as "create the repository" sends an operator to fix what is not broken.
    const { client: sdk } = client({
      repos: [],
      link: () => {
        throw new Error('503 unavailable: repo_linking_unwired')
      },
    })
    await expect(adoptRepoAsService({ ...options(), client: sdk })).rejects.toThrow(
      /repo_linking_unwired/,
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

describe('isRepoUnreachable', () => {
  it('recognises the documented reason, which is what the remedy is written for', () => {
    expect(isRepoUnreachable(notReachable())).toBe(true)
  })

  it('does NOT read a bare 404 as a missing repository', () => {
    // The failure this test pins: a deployment older than the endpoint has no route mounted at
    // `/api/v1/repos/link`, and Hono's unmatched-route 404 reaches the SDK as the same class with no
    // reason at all. Classified on status alone it read as "create the repository", which sent an
    // operator to create one they already had, in a loop this module exists to end.
    const unmounted = new CatFactoryNotFoundError({
      status: 404,
      code: 'unknown',
      message: '404 Not Found',
      requestId: 'req_2',
      body: {},
    })
    expect(isRepoUnreachable(unmounted)).toBe(false)
  })

  it('does not claim anything about a failure of another class', () => {
    expect(isRepoUnreachable(new Error('socket hang up'))).toBe(false)
  })
})
