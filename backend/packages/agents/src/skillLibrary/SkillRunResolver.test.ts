import type {
  AccountSkillRecord,
  AccountSkillRepository,
  GitHubClient,
  RepoFileContent,
  SkillSourceRecord,
  SkillSourceRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { SKILL_UNAVAILABLE_REASON } from '@cat-factory/contracts'
import { describe, expect, it, vi } from 'vitest'
import { SkillCatalogService } from './SkillCatalogService.js'
import { SkillRunResolver } from './SkillRunResolver.js'

// Coverage for the run-path skill resolver: it reads the persisted skill + resource
// manifest from the account catalog, fetches resource bodies at the pinned commit
// (bounded), degrades a fetch failure to a body-less reference (never throws), and
// throws only for an unknown/tombstoned skill.

const ACCOUNT = 'acct-1'
const WORKSPACE = 'ws-1'
const SOURCE_ID = 'sklsrc-1'
const SKILL_ID = `src:${SOURCE_ID}:triage`

function skillRecord(overrides: Partial<AccountSkillRecord> = {}): AccountSkillRecord {
  return {
    skillId: SKILL_ID,
    accountId: ACCOUNT,
    name: 'triage',
    description: 'Triage a bug',
    group: 'review',
    instructions: '1. Reproduce\n2. Classify',
    resources: [
      { path: '.claude/skills/triage/templates/report.md', sha: 'sha-r', size: 40 },
      { path: '.claude/skills/triage/big.bin', sha: 'sha-b', size: 200_000 },
    ],
    sourceId: SOURCE_ID,
    sourcePath: '.claude/skills/triage/SKILL.md',
    sourceSha: 'sha-manifest',
    pinnedCommit: 'commit-abc',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  }
}

function sourceRecord(): SkillSourceRecord {
  return {
    id: SOURCE_ID,
    accountId: ACCOUNT,
    repoOwner: 'acme',
    repoName: 'skills',
    gitRef: 'HEAD',
    dirPath: '.claude/skills',
    lastSyncedCommit: 'commit-abc',
    lastSyncedAt: 1,
    createdAt: 1,
    deletedAt: null,
  }
}

function makeResolver(opts: {
  record?: AccountSkillRecord | null
  source?: SkillSourceRecord | null
  installationId?: number | null
  getFileContent?: GitHubClient['getFileContent']
  /** Head-commit probe result for the dispatch-time freshness check (slice 4). */
  latestCommitSha?: GitHubClient['latestCommitSha']
  /** The freshness re-sync seam; absent ⇒ no dispatch-time probe at all. */
  syncSource?: (accountId: string, sourceId: string) => Promise<unknown>
}) {
  // Mutable so a `syncSource` fake can swap in a refreshed record, modelling a real re-sync.
  let record = opts.record === undefined ? skillRecord() : opts.record
  const accountSkillRepository = {
    get: vi.fn(async (accountId: string, skillId: string) =>
      record && record.accountId === accountId && record.skillId === skillId ? record : null,
    ),
    listByAccount: vi.fn(async () => (record ? [record] : [])),
  } as unknown as AccountSkillRepository
  const skillSourceRepository = {
    get: vi.fn(async () => (opts.source === undefined ? sourceRecord() : opts.source)),
  } as unknown as SkillSourceRepository
  const workspaceRepository = {
    accountOf: vi.fn(async () => ACCOUNT),
  } as unknown as WorkspaceRepository
  const githubClient = {
    getFileContent:
      opts.getFileContent ??
      vi.fn(async (): Promise<RepoFileContent | null> => ({
        content: 'REPORT BODY',
        sha: 'sha-r',
      })),
    // Default: the source dir head equals the last-synced commit → the probe reports "unchanged"
    // and no re-sync fires, so the non-freshness tests are unaffected.
    latestCommitSha: opts.latestCommitSha ?? vi.fn(async () => sourceRecord().lastSyncedCommit),
  } as unknown as GitHubClient
  const resolver = new SkillRunResolver({
    workspaceRepository,
    catalogService: new SkillCatalogService({ accountSkillRepository }),
    skillSourceRepository,
    githubClient,
    resolveInstallationId: async () =>
      opts.installationId === undefined ? 42 : opts.installationId,
    syncSource: opts.syncSource,
  })
  return { resolver, githubClient, setRecord: (r: AccountSkillRecord | null) => (record = r) }
}

describe('SkillRunResolver', () => {
  it('resolves instructions + fetches in-bounds resource bodies, referencing oversized ones by path', async () => {
    const { resolver } = makeResolver({})
    const { skill, version } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)

    expect(skill.name).toBe('triage')
    expect(skill.instructions).toContain('Reproduce')
    // The small template gets a body at its relative path; the 200KB .bin is over the
    // per-file cap, so it is referenced by repo path with no body.
    const tpl = skill.resources.find((r) => r.relPath === 'templates/report.md')
    expect(tpl?.body).toBe('REPORT BODY')
    const bin = skill.resources.find((r) => r.relPath === 'big.bin')
    expect(bin?.body).toBeUndefined()
    expect(bin?.path).toBe('.claude/skills/triage/big.bin')
    // Pins the version onto the step.
    expect(version).toEqual({ skillId: SKILL_ID, commit: 'commit-abc', sha: 'sha-manifest' })
  })

  it('fetches resource bodies at the pinned commit', async () => {
    const getFileContent = vi.fn(async () => ({ content: 'x', sha: 's' }))
    const { resolver } = makeResolver({ getFileContent })
    await resolver.resolveForRun(WORKSPACE, SKILL_ID)
    expect(getFileContent).toHaveBeenCalledWith(
      42,
      { owner: 'acme', repo: 'skills' },
      '.claude/skills/triage/templates/report.md',
      'commit-abc',
    )
  })

  it('degrades a GitHub fetch failure to a body-less reference (never throws)', async () => {
    const getFileContent = vi.fn(async () => {
      throw new Error('boom')
    })
    const { resolver } = makeResolver({ getFileContent })
    const { skill } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
    expect(skill.resources.every((r) => r.body === undefined)).toBe(true)
  })

  it('drops resource bodies (no throw) when no installation is available', async () => {
    const { resolver } = makeResolver({ installationId: null })
    const { skill } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
    expect(skill.resources).toHaveLength(2)
    expect(skill.resources.every((r) => r.body === undefined)).toBe(true)
  })

  it('treats a binary (NUL-byte) body as unmaterialisable', async () => {
    const getFileContent = vi.fn(async () => ({ content: 'a\u0000b', sha: 's' }))
    const { resolver } = makeResolver({ getFileContent })
    const { skill } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
    const tpl = skill.resources.find((r) => r.relPath === 'templates/report.md')
    expect(tpl?.body).toBeUndefined()
  })

  it('throws a ValidationError for an unknown / tombstoned skill', async () => {
    const { resolver } = makeResolver({ record: null })
    await expect(resolver.resolveForRun(WORKSPACE, SKILL_ID)).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  // Dispatch-time freshness probe (slice 4): a self-verifying head-commit check that re-syncs a
  // stale source before running, and degrades to the last-synced record on any failure.
  describe('dispatch-time freshness probe', () => {
    it('does not re-sync when the source head has not advanced', async () => {
      const syncSource = vi.fn(async () => {})
      const { resolver, githubClient } = makeResolver({
        syncSource,
        // Head equals the last-synced commit → unchanged.
        latestCommitSha: vi.fn(async () => 'commit-abc'),
      })
      const { skill } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
      expect(githubClient.latestCommitSha).toHaveBeenCalledOnce()
      expect(syncSource).not.toHaveBeenCalled()
      expect(skill.instructions).toContain('Reproduce')
    })

    it('re-syncs and uses the refreshed record when the source head advanced', async () => {
      const { resolver, setRecord } = makeResolver({
        latestCommitSha: vi.fn(async () => 'commit-new'),
        syncSource: vi.fn(async () => {
          setRecord(skillRecord({ instructions: 'FRESH INSTRUCTIONS', pinnedCommit: 'commit-new' }))
        }),
      })
      const { skill, version } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
      expect(skill.instructions).toBe('FRESH INSTRUCTIONS')
      expect(version.commit).toBe('commit-new')
    })

    it('degrades to the last-synced record when the probe fails (never throws)', async () => {
      const syncSource = vi.fn(async () => {})
      const { resolver } = makeResolver({
        syncSource,
        latestCommitSha: vi.fn(async () => {
          throw new Error('github 503')
        }),
      })
      const { skill } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
      expect(syncSource).not.toHaveBeenCalled()
      expect(skill.instructions).toContain('Reproduce')
    })

    it('degrades to the last-synced record when the re-sync itself fails', async () => {
      const { resolver } = makeResolver({
        latestCommitSha: vi.fn(async () => 'commit-new'),
        syncSource: vi.fn(async () => {
          throw new Error('sync blew up')
        }),
      })
      const { skill } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
      // The stale-but-usable record still resolves; the run proceeds one push behind, not failing.
      expect(skill.instructions).toContain('Reproduce')
    })

    it('skips the probe entirely when no syncSource is wired', async () => {
      const { resolver, githubClient } = makeResolver({
        latestCommitSha: vi.fn(async () => 'commit-new'),
        // syncSource omitted → the probe must not run.
      })
      const { skill } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
      expect(githubClient.latestCommitSha).not.toHaveBeenCalled()
      expect(skill.instructions).toContain('Reproduce')
    })

    it('keeps the last-synced record when a re-sync tombstones the skill (dir renamed upstream)', async () => {
      // The head advanced, the re-sync succeeds, but it retired THIS skill id (its dir was
      // renamed/removed), so the re-read finds nothing. The run must still proceed on the
      // last-synced record rather than throw — a genuinely gone skill fails later at the
      // pipeline-validation gate, not here.
      const { resolver, setRecord } = makeResolver({
        latestCommitSha: vi.fn(async () => 'commit-new'),
        syncSource: vi.fn(async () => setRecord(null)),
      })
      const { skill, version } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
      expect(skill.instructions).toContain('Reproduce')
      expect(version.commit).toBe('commit-abc')
    })

    it('does not probe when the source has been tombstoned', async () => {
      const syncSource = vi.fn(async () => {})
      const { resolver, githubClient } = makeResolver({
        syncSource,
        source: { ...sourceRecord(), deletedAt: 5_000 },
        latestCommitSha: vi.fn(async () => 'commit-new'),
      })
      const { skill } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
      expect(githubClient.latestCommitSha).not.toHaveBeenCalled()
      expect(syncSource).not.toHaveBeenCalled()
      expect(skill.instructions).toContain('Reproduce')
    })

    it('does not probe when no installation is available', async () => {
      const syncSource = vi.fn(async () => {})
      const { resolver, githubClient } = makeResolver({
        syncSource,
        installationId: null,
        latestCommitSha: vi.fn(async () => 'commit-new'),
      })
      const { skill } = await resolver.resolveForRun(WORKSPACE, SKILL_ID)
      expect(githubClient.latestCommitSha).not.toHaveBeenCalled()
      expect(syncSource).not.toHaveBeenCalled()
      expect(skill.instructions).toContain('Reproduce')
    })
  })
})

describe('SkillRunResolver.resolveManyForRun', () => {
  // What a dispatch resolving SEVERAL skills must not do: pay per skill for what the account
  // answers once. The catalog cache passes through on the Worker isolate profile, so a per-skill
  // loop is a repeated D1 read there and a repeated GitHub probe everywhere.
  function makeBatchResolver(records: AccountSkillRecord[]) {
    const resolveInstallationId = vi.fn(async () => 42)
    const accountSkillRepository = {
      get: vi.fn(
        async (_a: string, skillId: string) => records.find((r) => r.skillId === skillId) ?? null,
      ),
      listByAccount: vi.fn(async () => records),
    } as unknown as AccountSkillRepository
    const skillSourceRepository = {
      get: vi.fn(async () => sourceRecord()),
    } as unknown as SkillSourceRepository
    const githubClient = {
      getFileContent: vi.fn(async (): Promise<RepoFileContent | null> => null),
      latestCommitSha: vi.fn(async () => sourceRecord().lastSyncedCommit),
    } as unknown as GitHubClient
    const resolver = new SkillRunResolver({
      workspaceRepository: {
        accountOf: vi.fn(async () => ACCOUNT),
      } as unknown as WorkspaceRepository,
      catalogService: new SkillCatalogService({ accountSkillRepository }),
      skillSourceRepository,
      githubClient,
      resolveInstallationId,
      syncSource: vi.fn(async () => {}),
    })
    return {
      resolver,
      accountSkillRepository,
      skillSourceRepository,
      githubClient,
      resolveInstallationId,
    }
  }

  const lensA = skillRecord({
    skillId: `src:${SOURCE_ID}:security`,
    name: 'security',
    resources: [],
  })
  const lensB = skillRecord({ skillId: `src:${SOURCE_ID}:perf`, name: 'perf', resources: [] })

  it('answers in the order asked, off ONE catalog read and ONE probe per source', async () => {
    const { resolver, accountSkillRepository, skillSourceRepository, githubClient } =
      makeBatchResolver([lensA, lensB])

    const resolved = await resolver.resolveManyForRun(WORKSPACE, [lensB.skillId, lensA.skillId])

    expect(resolved.map((r) => r.skill.skillId)).toEqual([lensB.skillId, lensA.skillId])
    expect(accountSkillRepository.listByAccount).toHaveBeenCalledTimes(1)
    // Both skills came from one source dir, so its head commit is probed once and its row read once.
    expect(githubClient.latestCommitSha).toHaveBeenCalledTimes(1)
    expect(skillSourceRepository.get).toHaveBeenCalledTimes(1)
  })

  it('looks the installation up ONCE, for the probe and the resource fetches alike', async () => {
    // The freshness probe reads the source dir's head with it and every resource fetch reads its
    // blobs with it, so resolving it in each is the per-skill repetition this batch exists to
    // remove, one level down. It is also a real lookup: on the Worker it crosses to D1.
    const { resolver, resolveInstallationId } = makeBatchResolver([lensA, lensB])
    await resolver.resolveManyForRun(WORKSPACE, [lensA.skillId, lensB.skillId])
    expect(resolveInstallationId).toHaveBeenCalledTimes(1)
  })

  it('names the vanished id with a reason its caller can branch on', async () => {
    // The engine appends a remedy to THIS refusal and lets an outage on the same call path
    // through untouched, which it can only tell apart by the reason code.
    const { resolver } = makeBatchResolver([lensA])
    const error = await resolver
      .resolveManyForRun(WORKSPACE, [lensA.skillId, 'src:s:gone'])
      .then(() => null)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).details).toEqual({
      reason: SKILL_UNAVAILABLE_REASON,
      skillId: 'src:s:gone',
    })
  })

  it('throws for the first id the catalog cannot answer, naming it', async () => {
    const { resolver } = makeBatchResolver([lensA])
    await expect(
      resolver.resolveManyForRun(WORKSPACE, [lensA.skillId, 'src:s:gone']),
    ).rejects.toThrow(/src:s:gone/)
  })

  it('resolves nothing, and reads nothing, for an empty ask', async () => {
    const { resolver, accountSkillRepository } = makeBatchResolver([lensA])
    expect(await resolver.resolveManyForRun(WORKSPACE, [])).toEqual([])
    expect(accountSkillRepository.listByAccount).not.toHaveBeenCalled()
  })
})
