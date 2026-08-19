import type {
  AccountSkillRecord,
  GitHubClient,
  ResolvedSkill,
  ResolvedSkillResource,
  SkillSourceRecord,
  SkillSourceRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { probeRepoSourceStatus } from '../repoSourceSync/repo-source-sync.js'
import type { SkillCatalogService } from './SkillCatalogService.js'
import type { ResolveSkillInstallationId } from './SkillSourceService.js'

/** The resolved skill (the `AgentRunContext.skill` payload) + the per-run version pin. */
export interface ResolvedSkillForRun {
  /** Folded onto `AgentRunContext.skills` by the engine and rendered harness-aware by the executor. */
  skill: ResolvedSkill
  /** Pinned onto the run step (`PipelineStep.skillVersion`) so the run records exactly what ran. */
  version: { skillId: string; commit: string | null; sha: string }
}

/** Null byte — the binary-file heuristic for a body we decline to materialise. */
const NUL = '\u0000'

/**
 * Source rows read during ONE resolve, `null` where the row is absent or tombstoned. Passed down
 * the call rather than held on the resolver, so it can never outlive the dispatch that made it.
 */
type SourceReads = Map<string, SkillSourceRecord | null>

/**
 * Resolves the catalog skills ONE dispatch runs, whoever asked for them: a `skill` step's pick, an
 * agent kind's declaration, or a review task's queue. It reads the account's skill catalog for the
 * persisted instructions + resource manifest, then fetches the resource BODIES at each skill's
 * immutable pinned commit — bounded (per-file + total caps; oversized/binary files are referenced
 * by repo path in the prompt instead of materialised).
 *
 * {@link resolveManyForRun} is the real entry point and {@link resolveForRun} is the one-id case of
 * it, because a dispatch resolving SEVERAL skills must not pay per skill for what the account
 * answers once: one `accountOf`, one catalog read, one installation lookup, and one freshness
 * probe per SOURCE rather than per skill. The catalog cache passes through on the Worker isolate
 * profile, so a per-skill loop is a real repeated D1 read there, not a cache hit.
 *
 * The run path never DEPENDS on a live GitHub fetch: the instructions come from our own synced
 * store, and a resource fetch failure (a transient GitHub error, a missing installation, an
 * unlinked source) degrades that resource to "no body, reference by path" rather than failing the
 * run. It throws ONLY for a genuine misconfiguration the run can't proceed past — an unknown /
 * tombstoned skill id — so a dispatch never silently runs against nothing.
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

  /** The one-id case of {@link resolveManyForRun}, which throws rather than answering empty. */
  async resolveForRun(workspaceId: string, skillId: string): Promise<ResolvedSkillForRun> {
    const [resolved] = await this.resolveManyForRun(workspaceId, [skillId])
    return resolved!
  }

  /**
   * Resolve several catalog skills for one dispatch, in the order asked. Throws on the FIRST id
   * the catalog cannot answer (an unknown or tombstoned skill): a dispatch that silently ran
   * without a skill somebody picked is the failure this exists to refuse.
   */
  async resolveManyForRun(
    workspaceId: string,
    skillIds: readonly string[],
  ): Promise<ResolvedSkillForRun[]> {
    if (skillIds.length === 0) return []
    const accountId = await this.deps.workspaceRepository.accountOf(workspaceId)
    if (!accountId) {
      throw new ValidationError(
        `Cannot resolve skill '${skillIds[0]}': workspace ${workspaceId} has no account.`,
      )
    }
    // ONE catalog read for every id, indexed — never `catalogService.get` per skill, which is a
    // repeated repository read wherever the catalog cache passes through (the Worker isolate).
    const byId = await this.indexCatalog(accountId)
    const records = skillIds.map((skillId) => {
      const record = byId.get(skillId)
      if (record) return record
      // The FACT only: what to do about it depends on where the id was picked (a pipeline step,
      // an agent kind's declaration, a task's queue), which this resolver cannot see. The engine's
      // `run-skills` knows, and appends the remedy naming the surface the human edits.
      throw new ValidationError(
        `Skill '${skillId}' is no longer available (it was removed, or its source was unlinked).`,
        { skillId },
      )
    })
    // Freshness backstop: if a source dir advanced since the last sync, re-sync so the run uses
    // current instructions rather than a stale snapshot (the layered freshness story — the
    // push-webhook fan-out keeps it warm, this probe is the self-verifying catch at dispatch).
    // Probed once per SOURCE, not per skill; degrades to the last-synced records on ANY failure,
    // never wedging a run over a transient GitHub error.
    const sources: SourceReads = new Map()
    const fresh = await this.refreshStaleSources(accountId, records, sources)
    const installationId = await this.resolveInstallation(accountId)
    const out: ResolvedSkillForRun[] = []
    for (const record of fresh) {
      const resources = await this.resolveResources(record, installationId, sources)
      out.push({
        skill: {
          skillId: record.skillId,
          origin: 'catalog',
          name: record.name,
          description: record.description,
          instructions: record.instructions,
          resources,
        },
        version: { skillId: record.skillId, commit: record.pinnedCommit, sha: record.sourceSha },
      })
    }
    return out
  }

  /** The account's live catalog, once, keyed by skill id. */
  private async indexCatalog(accountId: string): Promise<Map<string, AccountSkillRecord>> {
    const catalog = await this.deps.catalogService.resolveCatalog(accountId)
    return new Map(catalog.map((record) => [record.skillId, record]))
  }

  /**
   * The installation that reads this account's repos, or null when there is none. Resolved ONCE
   * per resolve: it is the same answer for every skill, and a null degrades each of them to
   * "reference the resource by path" rather than failing anything.
   *
   * A LOOKUP FAILURE is that same null, which is a deliberate unification: the freshness probe
   * already treated a throw here as "cannot probe, run on the last sync", while the resource
   * fetch let it propagate and fail a dispatch its own contract says never fails. Neither the
   * instructions nor the version pin depend on this call, so the honest reading of both is that
   * we could not reach the repo and the prompt says so by referencing resources by path.
   */
  private async resolveInstallation(accountId: string): Promise<number | null> {
    try {
      return await this.deps.resolveInstallationId(accountId)
    } catch {
      // No logger on this collaborator (nor on the sibling probe's catch below); the dispatch
      // that called it reports what the run actually got.
      return null
    }
  }

  /**
   * A source row, read at most once per RESOLVE however many skills came from it.
   *
   * The map is created per call and thrown away with it, never held on the resolver: the Node
   * facade builds its container once per PROCESS, so an instance-level map would be a standing
   * cache of rows whose sync pins move under it, with no invalidation. Anything that must outlive
   * one dispatch belongs to the app cache seam.
   */
  private async sourceOf(
    sources: SourceReads,
    sourceId: string,
  ): Promise<SkillSourceRecord | null> {
    const seen = sources.get(sourceId)
    if (seen !== undefined) return seen
    const source = await this.deps.skillSourceRepository.get(sourceId)
    const live = source && source.deletedAt === null ? source : null
    sources.set(sourceId, live)
    return live
  }

  /**
   * Re-sync every SOURCE among these records whose dir advanced since the last sync, and return
   * the records as they stand afterwards; on ANY failure (or with the probe/re-sync unwired) the
   * last-synced records come back unchanged. A self-verifying freshness probe — the run never
   * DEPENDS on it: the worst case is running one push behind, never a failure.
   *
   * Per SOURCE, not per skill, and that is the whole reason this is a batch: a review queueing
   * four playbooks from one repo directory probes that dir's head ONCE and re-syncs it ONCE,
   * where a per-skill loop paid four GitHub reads and four re-syncs for one answer.
   */
  private async refreshStaleSources(
    accountId: string,
    records: AccountSkillRecord[],
    sources: SourceReads,
  ): Promise<AccountSkillRecord[]> {
    const syncSource = this.deps.syncSource
    if (!syncSource) return records
    try {
      const installationId = await this.resolveInstallation(accountId)
      if (installationId === null) return records
      let synced = false
      for (const sourceId of new Set(records.map((record) => record.sourceId))) {
        const source = await this.sourceOf(sources, sourceId)
        if (!source) continue
        const status = await probeRepoSourceStatus({
          source,
          installationId,
          githubClient: this.deps.githubClient,
        })
        if (!status.changed) continue
        await syncSource(accountId, sourceId)
        synced = true
      }
      if (!synced) return records
      // Re-read the (now-current) catalog once. A re-sync that tombstoned one of these skills (its
      // dir was renamed/removed upstream) leaves nothing to read — keep the last-synced record so
      // the run still proceeds; a genuinely gone skill fails later at the pipeline-validation gate.
      // The source rows moved too (their sync pins), so the reads collected so far are dropped.
      sources.clear()
      const byId = await this.indexCatalog(accountId)
      return records.map((record) => byId.get(record.skillId) ?? record)
    } catch {
      return records
    }
  }

  /**
   * Fetch the skill's resource bodies at its pinned commit, bounded. Never throws — every
   * failure mode (missing source/installation, oversized/binary/unreadable file, GitHub error)
   * degrades to a resource with no `body`, which the executor references by repo path instead.
   *
   * Takes the dispatch's already-resolved installation and reads its source row through the
   * per-resolve map, so several skills off one source cost one row read between them. The byte
   * caps stay PER SKILL: they bound what one playbook can put in a prompt, and the number of
   * playbooks a dispatch may carry is bounded by whoever queued them.
   */
  private async resolveResources(
    record: AccountSkillRecord,
    installationId: number | null,
    sources: SourceReads,
  ): Promise<ResolvedSkillResource[]> {
    if (record.resources.length === 0) return []
    const skillDir = dirOf(record.sourcePath)
    // Reference-only projection (no bodies) — the graceful fallback when we can't fetch.
    const withoutBodies = () =>
      record.resources.map((r) => ({ path: r.path, relPath: relTo(skillDir, r.path) }))

    if (installationId === null) return withoutBodies()
    const source = await this.sourceOf(sources, record.sourceId)
    if (!source) return withoutBodies()

    const ref = { owner: source.repoOwner, repo: source.repoName }
    const gitRef = record.pinnedCommit ?? source.gitRef
    const out: ResolvedSkillResource[] = []
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
