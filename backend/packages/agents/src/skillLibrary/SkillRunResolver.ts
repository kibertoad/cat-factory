import type {
  AccountSkillRecord,
  AgentRunContext,
  GitHubClient,
  SkillSourceRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { probeRepoSourceStatus } from '../repoSourceSync/repo-source-sync.js'
import type { SkillCatalogService } from './SkillCatalogService.js'
import type { ResolveSkillInstallationId } from './SkillSourceService.js'

/** The resolved skill (the `AgentRunContext.skill` payload) + the per-run version pin. */
export interface ResolvedSkillForRun {
  /** Folded onto `AgentRunContext.skill` by the engine and rendered harness-aware by the executor. */
  skill: NonNullable<AgentRunContext['skill']>
  /** Pinned onto the run step (`PipelineStep.skillVersion`) so the run records exactly what ran. */
  version: { skillId: string; commit: string | null; sha: string }
}

/** Null byte — the binary-file heuristic for a body we decline to materialise. */
const NUL = '\u0000'

/**
 * Resolves a picked skill for a `skill` pipeline step at dispatch. Given the workspace + the
 * step's `stepOptions.skillId`, it reads the account's cached skill catalog for the persisted
 * instructions + resource manifest, then fetches the resource BODIES at the skill's immutable
 * pinned commit — bounded (per-file + total caps; oversized/binary files are referenced by repo
 * path in the prompt instead of materialised).
 *
 * The run path never DEPENDS on a live GitHub fetch: the instructions come from our own synced
 * store, and a resource fetch failure (a transient GitHub error, a missing installation, an
 * unlinked source) degrades that resource to "no body, reference by path" rather than failing the
 * run. It throws ONLY for a genuine misconfiguration the run can't proceed past — an unknown /
 * tombstoned skill id — so a `skill` step never silently runs against nothing.
 *
 * Structurally implements the engine's `SkillResolver` seam (mirroring how
 * `FragmentLibraryService` implements `FragmentBodyResolver`).
 */
export class SkillRunResolver {
  constructor(
    private readonly deps: {
      workspaceRepository: WorkspaceRepository
      catalogService: SkillCatalogService
      skillSourceRepository: SkillSourceRepository
      githubClient: GitHubClient
      resolveInstallationId: ResolveSkillInstallationId
      /**
       * Re-sync one source, used by the dispatch-time freshness probe (slice 4). Wired to
       * {@link SkillSourceService.sync} by the composition root. Absent ⇒ no dispatch-time
       * probe (the push-webhook fan-out is then the only freshness path).
       */
      syncSource?: (accountId: string, sourceId: string) => Promise<unknown>
    },
  ) {}

  /** Per-resource body cap; larger files are referenced by path, not materialised. */
  private static readonly MAX_RESOURCE_BYTES = 48 * 1024
  /** Aggregate body cap across all of a skill's resources. */
  private static readonly MAX_TOTAL_BYTES = 200 * 1024

  async resolveForRun(workspaceId: string, skillId: string): Promise<ResolvedSkillForRun> {
    const accountId = await this.deps.workspaceRepository.accountOf(workspaceId)
    if (!accountId) {
      throw new ValidationError(
        `Cannot resolve skill '${skillId}': workspace ${workspaceId} has no account.`,
      )
    }
    const cached = await this.deps.catalogService.get(accountId, skillId)
    if (!cached) {
      throw new ValidationError(
        `Skill '${skillId}' is no longer available (removed or its source was unlinked). Update the pipeline step to a current skill.`,
      )
    }
    // Freshness backstop: if the source dir advanced since the last sync, re-sync so the run
    // uses current instructions rather than a stale snapshot (the layered freshness story —
    // the push-webhook fan-out keeps it warm, this probe is the self-verifying catch at
    // dispatch). Bounded to ONE head-commit probe on the happy path; degrades to the
    // last-synced record on ANY failure, never wedging a run over a transient GitHub error.
    const record = await this.refreshIfStale(accountId, cached)
    const resources = await this.resolveResources(record)
    return {
      skill: {
        skillId: record.skillId,
        name: record.name,
        description: record.description,
        instructions: record.instructions,
        resources,
      },
      version: { skillId: record.skillId, commit: record.pinnedCommit, sha: record.sourceSha },
    }
  }

  /**
   * If the skill's source dir advanced since the last sync, re-sync it and return the refreshed
   * catalog record; otherwise (or on ANY failure, or when the probe/re-sync isn't wired) return
   * the last-synced record unchanged. A self-verifying freshness probe — the run never DEPENDS on
   * it: the worst case is running one push behind, never a failure. Costs one `latestCommitSha`
   * read on the unchanged path (the common case), plus a re-sync only when the head actually moved.
   */
  private async refreshIfStale(
    accountId: string,
    record: AccountSkillRecord,
  ): Promise<AccountSkillRecord> {
    const syncSource = this.deps.syncSource
    if (!syncSource) return record
    try {
      const source = await this.deps.skillSourceRepository.get(record.sourceId)
      if (!source || source.deletedAt !== null) return record
      const installationId = await this.deps.resolveInstallationId(accountId)
      if (installationId === null) return record
      const status = await probeRepoSourceStatus({
        source,
        installationId,
        githubClient: this.deps.githubClient,
      })
      if (!status.changed) return record
      await syncSource(accountId, record.sourceId)
      // Re-read the (now-current) record. A re-sync that tombstoned this skill (its dir was
      // renamed/removed upstream) leaves nothing to read — keep the last-synced record so the
      // run still proceeds; a genuinely gone skill fails later at the pipeline-validation gate.
      const refreshed = await this.deps.catalogService.get(accountId, record.skillId)
      return refreshed ?? record
    } catch {
      return record
    }
  }

  /**
   * Fetch the skill's resource bodies at its pinned commit, bounded. Never throws — every
   * failure mode (missing source/installation, oversized/binary/unreadable file, GitHub error)
   * degrades to a resource with no `body`, which the executor references by repo path instead.
   */
  private async resolveResources(
    record: AccountSkillRecord,
  ): Promise<NonNullable<AgentRunContext['skill']>['resources']> {
    if (record.resources.length === 0) return []
    const skillDir = dirOf(record.sourcePath)
    // Reference-only projection (no bodies) — the graceful fallback when we can't fetch.
    const withoutBodies = () =>
      record.resources.map((r) => ({ path: r.path, relPath: relTo(skillDir, r.path) }))

    const source = await this.deps.skillSourceRepository.get(record.sourceId)
    if (!source || source.deletedAt !== null) return withoutBodies()
    const installationId = await this.deps.resolveInstallationId(record.accountId)
    if (installationId === null) return withoutBodies()

    const ref = { owner: source.repoOwner, repo: source.repoName }
    const gitRef = record.pinnedCommit ?? source.gitRef
    const out: NonNullable<AgentRunContext['skill']>['resources'] = []
    let total = 0
    for (const resource of record.resources) {
      const relPath = relTo(skillDir, resource.path)
      // Oversized by the manifest size, or the running total is spent → reference by path.
      if (
        resource.size > SkillRunResolver.MAX_RESOURCE_BYTES ||
        total >= SkillRunResolver.MAX_TOTAL_BYTES
      ) {
        out.push({ path: resource.path, relPath })
        continue
      }
      try {
        const file = await this.deps.githubClient.getFileContent(
          installationId,
          ref,
          resource.path,
          gitRef,
        )
        // Absent, binary (NUL byte), or would blow the aggregate cap → reference by path only.
        if (
          !file ||
          file.content.includes(NUL) ||
          total + byteLength(file.content) > SkillRunResolver.MAX_TOTAL_BYTES
        ) {
          out.push({ path: resource.path, relPath })
          continue
        }
        total += byteLength(file.content)
        out.push({ path: resource.path, relPath, body: file.content })
      } catch {
        // A transient GitHub failure must never wedge a run — degrade this resource.
        out.push({ path: resource.path, relPath })
      }
    }
    return out
  }
}

/** Directory portion of a repo path (`.claude/skills/x/SKILL.md` → `.claude/skills/x`). */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i) : ''
}

/**
 * A resource's path relative to the skill directory (`.claude/skills/x/tpl/a.md` within
 * `.claude/skills/x` → `tpl/a.md`), so it materialises under the skill / `.cat-context/skill`
 * preserving its sub-structure. Falls back to the basename if the path is outside the dir.
 */
function relTo(dir: string, path: string): string {
  const prefix = dir ? `${dir}/` : ''
  if (prefix && path.startsWith(prefix)) return path.slice(prefix.length)
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}
