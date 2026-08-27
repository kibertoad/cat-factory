import { describe, expect, it } from 'vitest'
import {
  applyReset,
  planReset,
  type ResetClient,
  type ResetPassOnDisk,
  resetSucceeded,
} from '@cat-factory/acceptance-kit'
import type { BoardConfig } from '../src/config.ts'
import { serviceTitles } from '../src/instructions.ts'
import {
  type AcceptanceResetClient,
  acceptanceResetInput,
  type AcceptanceResetOptions,
  ledgerServiceIds,
} from '../src/reset.ts'
import type { World } from '../src/world.ts'
import { emptyWorld } from '../src/world.ts'

// What is pinned here is what only THIS suite knows, which is what `src/reset.ts` is now made of:
// which frames its two questions reach and in whose words, what it cannot free, what it could not
// read, and the leftovers paragraph an operator takes on trust because they cannot see the
// repositories from here. The plan/apply machinery under it belongs to the kit and is pinned there
// (`backend/packages/acceptance-kit/src/reset.test.ts`): the write order, the retention rule and the
// pointer rule are not re-asserted here, only driven, since a suite's job is to point them at the
// right frames.

const CONFIG: BoardConfig = {
  baseUrl: 'http://127.0.0.1:8787',
  apiKey: 'cf_live_key',
  workspaceId: 'ws_1',
  repoOwner: 'acme',
  namePrefix: 'cf-acc',
  repos: { backend: 'catalog-api', frontend: 'catalog-web' },
  stateDir: '/state',
}

const TITLES = serviceTitles(CONFIG.namePrefix)

type Fake = {
  client: AcceptanceResetClient
  /** Every write, in the order it was made: `task:<id>` / `service:<id>`. */
  calls: string[]
  /** Files removed, in order. */
  removed: string[]
  files: { remove(path: string): boolean }
}

function fake(
  options: {
    repos?: readonly { name: string; serviceId?: string | null; linkedElsewhere?: boolean }[]
    services?: readonly { serviceId: string; title: string }[]
    tasks?: Readonly<Record<string, readonly string[]>>
  } = {},
): Fake {
  const calls: string[] = []
  const removed: string[] = []
  const client: ResetClient = {
    services: async () => options.services ?? [],
    tasks: async (serviceId) =>
      (options.tasks?.[serviceId] ?? []).map((taskId) => ({
        taskId,
        title: `task ${taskId}`,
        done: false,
      })),
    deleteTask: async (taskId) => {
      calls.push(`task:${taskId}`)
    },
    deleteService: async (serviceId) => {
      calls.push(`service:${serviceId}`)
    },
  }
  return {
    calls,
    removed,
    files: {
      remove: (path) => {
        removed.push(path)
        return true
      },
    },
    client: {
      ...client,
      repos: async () =>
        (options.repos ?? []).map((repo) => ({
          owner: CONFIG.repoOwner,
          name: repo.name,
          serviceId: repo.serviceId ?? null,
          linkedElsewhere: repo.linkedElsewhere ?? false,
        })),
    },
  }
}

/** A pass on disk whose ledger names the given services. */
function ledger(
  runId: string,
  services: { backend?: string; frontend?: string; issueUrl?: string } = {},
): ResetPassOnDisk<World> {
  const world: World = {
    ...emptyWorld(runId),
    ...(services.backend
      ? { backend: { blockId: services.backend, serviceId: services.backend, repoName: 'a/b' } }
      : {}),
    ...(services.frontend
      ? { frontend: { blockId: services.frontend, serviceId: services.frontend, repoName: 'a/c' } }
      : {}),
    ...(services.issueUrl
      ? {
          intakeIssue: {
            provider: 'github',
            owner: 'acme',
            repo: 'catalog-api',
            number: 7,
            url: services.issueUrl,
          },
        }
      : {}),
  }
  return {
    runId,
    ledgerPath: `/state/${runId}.json`,
    journalPath: `/state/${runId}.journal.jsonl`,
    facts: world,
  }
}

async function plan(f: Fake, overrides: Partial<AcceptanceResetOptions> = {}) {
  return planReset(
    f.client,
    await acceptanceResetInput(f.client, {
      config: CONFIG,
      namedRunId: null,
      all: false,
      passes: [],
      // No pointer FILE, which is a different state from one naming nothing: see `readLatestPointer`.
      latest: null,
      ...overrides,
    }),
  )
}

describe('what this suite targets', () => {
  it('plans the frame a target repository backs, with the tasks under it', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }, { name: 'catalog-web' }],
      services: [{ serviceId: 'blk_api', title: 'Renamed by hand' }],
      tasks: { blk_api: ['blk_t1', 'blk_t2'] },
    })

    const result = await plan(f)

    expect(result.frames).toHaveLength(1)
    expect(result.frames[0]?.serviceId).toBe('blk_api')
    expect(result.frames[0]?.reasons).toEqual([
      { kind: 'targeted', because: "backs 'acme/catalog-api'" },
    ])
    expect(result.frames[0]?.tasks.map((task) => task.taskId)).toEqual(['blk_t1', 'blk_t2'])
  })

  it('plans a frame that took a pass TITLE even when it backs neither repository', async () => {
    // The second refusal a reset answers (`board-titles`), and the reason the target is a union: a
    // frame whose repository was re-pointed by hand keeps the title, and a target built from the
    // repositories alone would clear the board and leave that gate still firing.
    const f = fake({
      repos: [{ name: 'catalog-api' }, { name: 'catalog-web' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
    })

    const result = await plan(f)

    expect(result.frames).toHaveLength(1)
    expect(result.frames[0]?.reasons).toEqual([
      { kind: 'targeted', because: `holds the title '${TITLES.backend}'` },
    ])
  })

  it('states BOTH questions when one frame answers each, rather than the first that matched', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
    })

    const result = await plan(f, { passes: [ledger('p1', { backend: 'blk_api' })] })

    expect(result.frames[0]?.reasons).toEqual([
      { kind: 'targeted', because: "backs 'acme/catalog-api'" },
      { kind: 'targeted', because: `holds the title '${TITLES.backend}'` },
    ])
  })

  it('states a repository it cannot free as unfreeable rather than as nothing to do', async () => {
    // `serviceId: null` WITH `linkedElsewhere` is a frame this workspace-scoped key cannot name, so
    // there is no id to delete. Reading it as "nothing to do" would send an operator back round the
    // same refusal wondering why the reset changed nothing.
    const f = fake({
      repos: [
        { name: 'catalog-api', serviceId: null, linkedElsewhere: true },
        { name: 'catalog-web' },
      ],
      services: [],
    })

    const result = await plan(f)

    expect(result.frames).toEqual([])
    expect(result.blockers.map((entry) => entry.subject)).toEqual(['acme/catalog-api'])
    expect(result.blockers[0]?.steps.join(' ')).toContain('repo_service_homed_elsewhere')
    // Both causes are named, because they answer identically and have opposite fixes.
    expect(result.blockers[0]?.steps.join(' ')).toContain('ARCHIVED')
  })

  it('notes a configured repository this workspace has not linked, so an empty plan is not read as a clean board', async () => {
    // "Nothing on this board backs it" and "this read cannot see it" are different facts, and only
    // the first means a reset has nothing to do: a repository spoken for on ANOTHER board reads
    // identically here, and `target-repos` is what tells them apart.
    const f = fake({ repos: [{ name: 'catalog-api', serviceId: 'blk_api' }], services: [] })

    const result = await plan(f)

    expect(result.notes.join('\n')).toContain('Not linked to this workspace')
    expect(result.notes.join('\n')).toContain('acme/catalog-web')
    expect(result.notes.join('\n')).toContain('target-repos')
  })

  it('names the frames one ledger holds, which is what a NAMED pass widens the plan by', async () => {
    expect(
      ledgerServiceIds({
        ...emptyWorld('p1'),
        backend: { blockId: 'blk_api', serviceId: 'blk_api', repoName: 'a/b' },
        frontend: { blockId: 'blk_web', serviceId: 'blk_web', repoName: 'a/c' },
      }),
    ).toEqual(['blk_api', 'blk_web'])
    // Total over a ledger that has recorded nothing yet: a refused attempt names no frame.
    expect(ledgerServiceIds(emptyWorld('p1'))).toEqual([])
  })

  it('carries a named pass through to the frames its ledger holds and the files that go', async () => {
    // One end-to-end drive of the kit's machinery through this suite's answers, so a seam wired to
    // the wrong callback fails here rather than in a pass.
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [
        { serviceId: 'blk_api', title: TITLES.backend },
        { serviceId: 'blk_web', title: 'old-prefix Catalog Web' },
      ],
    })
    const result = await plan(f, {
      namedRunId: 'p1',
      passes: [ledger('p1', { backend: 'blk_api', frontend: 'blk_web' })],
      latest: { runId: 'p1', path: '/state/latest.json' },
    })

    const report = await applyReset(f.client, f.files, result)

    expect(f.calls).toEqual(['service:blk_api', 'service:blk_web'])
    expect(f.removed).toEqual(['/state/p1.json', '/state/p1.journal.jsonl', '/state/latest.json'])
    expect(resetSucceeded(report)).toBe(true)
  })
})

describe('what this suite says it does NOT reclaim', () => {
  it('always names the two repositories and any filed issue', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
    })

    const result = await plan(f, {
      passes: [
        ledger('p1', { backend: 'blk_api', issueUrl: 'https://github.com/acme/x/issues/7' }),
      ],
    })

    const notes = result.leftovers.join('\n')
    expect(notes).toContain('acme/catalog-api')
    expect(notes).toContain('https://github.com/acme/x/issues/7')
    expect(notes).toContain('ACCEPTANCE_K3S_NAMESPACE_TEMPLATE')
  })

  it('names a repository a deleted frame backed BEYOND the configured two', async () => {
    // Under `--all` the leftovers paragraph's two repositories are a fraction of what was emptied,
    // and a repository whose content survives is the leftover that changes what the next pass does.
    const f = fake({
      repos: [
        { name: 'catalog-api', serviceId: 'blk_api' },
        { name: 'unrelated-svc', serviceId: 'blk_other' },
      ],
      services: [
        { serviceId: 'blk_api', title: TITLES.backend },
        { serviceId: 'blk_other', title: 'Somebody else’s service' },
      ],
    })

    const result = await plan(f, { all: true })

    expect(result.leftovers.join('\n')).toContain('acme/unrelated-svc')
    // The configured pair is named by the paragraph that always runs, so it is not repeated here.
    expect(result.leftovers[0]).not.toContain('catalog-api')
  })

  // The leftovers paragraph is the part of this output an operator takes on trust, because they
  // cannot see the repositories from here. `--purge-repos` disproves two of its sentences, so a plan
  // that kept printing them would be actively wrong about the one thing it is relied on for.
  it('stops promising the repositories keep their content once the purge is running', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
    })

    const result = await plan(f, {
      purgeProvider: true,
      passes: [
        ledger('p1', { backend: 'blk_api', issueUrl: 'https://github.com/acme/x/issues/7' }),
      ],
    })

    const notes = result.leftovers.join('\n')
    expect(notes).not.toContain('keep their CONTENT')
    expect(notes).not.toContain('stays open')
    // The cluster note is untouched: no flag here reclaims a namespace, so that one is still true.
    expect(notes).toContain('ACCEPTANCE_K3S_NAMESPACE_TEMPLATE')
  })

  // The purge empties the two repositories the `.env` names and no others, so under `--all` the
  // repositories it does NOT touch are the only unreclaimed ones left. Dropping their note along
  // with the sentences the purge disproves is how a purge report comes to read as covering every
  // repository the plan just deleted a frame for.
  it('still names a repository the purge does not touch', async () => {
    const f = fake({
      repos: [
        { name: 'catalog-api', serviceId: 'blk_api' },
        { name: 'unrelated-svc', serviceId: 'blk_other' },
      ],
      services: [
        { serviceId: 'blk_api', title: TITLES.backend },
        { serviceId: 'blk_other', title: 'Somebody else’s service' },
      ],
    })

    const result = await plan(f, { all: true, purgeProvider: true })

    const notes = result.leftovers.join('\n')
    expect(notes).toContain('acme/unrelated-svc')
    expect(notes).toContain('NOT purged')
  })
})
