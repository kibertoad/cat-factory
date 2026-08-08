import {
  SPEC_FEATURES_DIR,
  SPEC_MODULES_DIR,
  SPEC_SERVICE_PATH,
  safeParseDomainRule,
  safeParseRequirementGroup,
  safeParseRequirementItem,
  safeParseSpecModule,
  type RequirementGroup,
  type ServiceSpecView,
  type SpecAnchorState,
  type SpecDoc,
  type SpecFeatureFile,
  type SpecModule,
  type SpecReadIssue,
} from '@cat-factory/contracts'
import type { RepoContentEntry, RepoFileContent, RepoFiles } from '@cat-factory/kernel'
import pMap from 'p-map'

// Reassemble the SHARDED `spec/` artifact into a single {@link ServiceSpecView}, reading it
// checkout-free from a branch via {@link RepoFiles}. The spec-writer harness writes the tree
// across many files (one canonical JSON shard per feature group, plus seeded Gherkin `.feature`
// files) so concurrent task branches merge cleanly; the slugs are filesystem-only
// (collision-suffixed, name-sorted), so the only way to recover the tree is to walk the
// directories — names live inside the shards, not the paths. This is the read-side mirror of the
// harness's `readExistingSpec`, over HTTP.
//
// THREE surfaces read the spec through this one function, and that is deliberate: the SPA's
// requirements window, the run-evidence reductions (the verification report's requirement join and
// the outcome card), and `GET /api/v1/services/:serviceId/spec`. A second walk with its own
// salvage rules is how two surfaces come to disagree about what a malformed group renders as.
//
// Three properties it guarantees, so no caller sees a 500 or a misleading "no spec" state:
//   1. Every repo read is total: a non-404 provider error (rate limit, 5xx, network) degrades to
//      a partial view instead of erroring the caller.
//   2. The tree is validated PER NODE, down to the individual requirement/rule: a malformed
//      module shard is dropped without the rest of the tree, and a group shard is salvaged one
//      requirement/rule at a time (so ONE field past a schema cap the lenient writer never
//      enforced drops only that requirement, not the whole group with its valid siblings).
//   3. Both of those DEGRADE THE TREE, so both are REPORTED in `diagnostics`. A salvaging reader
//      that reports nothing is indistinguishable from a repo that genuinely holds less, and the
//      anchor state is the sharpest case: "no spec on this branch", "the provider would not answer"
//      and "`spec/service.json` is corrupt" all produce the same empty view and need three
//      different reactions. Every consumer is free to fold them (the SPA renders one empty state);
//      what none of them can do is fold what the reader never distinguished.

// Cap concurrent GitHub reads so a large spec doesn't fire a burst of dozens of parallel
// requests at once (GitHub flags high concurrency as secondary-rate-limit abuse). The reads
// are still parallel, just bounded.
//
// Exported because the spec-promotion post-op re-reads the same tree to diff it, and the two
// walks must share one bound: a second uncapped walk would reintroduce exactly the burst this
// number exists to prevent, on the same repo, moments apart.
export const READ_CONCURRENCY = 12

/**
 * The issues one read pass accumulated.
 *
 * Threaded explicitly through every helper rather than kept in a module-level array: the reader is
 * called concurrently (two runs, two workspaces, one process), and a shared accumulator would
 * attribute one repo's outage to another's response.
 */
class IssueLog {
  readonly issues: SpecReadIssue[] = []

  add(path: string, kind: SpecReadIssue['kind'], dropped = 0): void {
    this.issues.push({ path, kind, dropped })
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

/** A trimmed non-empty string, else undefined — so a blank value falls back like a missing one. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A group shard's salvage outcome: what survived, and how many items did not. */
interface GroupShardParse {
  group?: RequirementGroup
  dropped: number
}

/**
 * Parse one group shard, salvaging it PER REQUIREMENT/RULE. A strict whole-shard parse is
 * tried first (the happy path). On failure — typically ONE field past a schema cap the
 * lenient writer never enforces (e.g. a >120-char requirement title) — the group is rebuilt
 * from its individually-validated requirements/rules, so one bad item drops only itself, not
 * the whole group with its valid siblings. `group` is undefined only when even the group's own
 * identity (its name) is unrecoverable.
 *
 * `dropped` counts the items the salvage lost, which is what makes the salvage REPORTABLE: a
 * rebuilt group is a valid-looking group that is quietly missing requirements, and a reader
 * counting coverage off it would report a smaller spec as a complete one.
 */
function coerceGroupShard(value: unknown): GroupShardParse {
  const strict = safeParseRequirementGroup(value)
  if (strict) return { group: strict, dropped: 0 }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { dropped: 0 }
  const raw = value as { requirements?: unknown; rules?: unknown }
  const rawRequirements = Array.isArray(raw.requirements) ? raw.requirements : []
  const rawRules = Array.isArray(raw.rules) ? raw.rules : []
  const requirements = rawRequirements
    .map(safeParseRequirementItem)
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
  const rules = rawRules
    .map(safeParseDomainRule)
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
  const dropped = rawRequirements.length - requirements.length + (rawRules.length - rules.length)
  // Re-validate the rebuilt group: this enforces the group-level fields (name/summary) while
  // the requirements/rules are already valid. A bad group name is unrecoverable ⇒ undefined.
  const group = safeParseRequirementGroup({ ...raw, requirements, rules })
  return group ? { group, dropped } : { dropped: 0 }
}

/**
 * Read a file, never throwing.
 *
 * Null covers BOTH "the path is absent" (what `getFile` returns) and "the read failed", because
 * every caller here does the same thing with either. The difference is not lost, though: a failure
 * is recorded on the log, so the caller that has to tell them apart reads the diagnostics.
 */
async function safeGetFile(
  repo: RepoFiles,
  path: string,
  ref: string,
  log: IssueLog,
): Promise<RepoFileContent | null> {
  try {
    return await repo.getFile(path, ref)
  } catch {
    log.add(path, 'read_failed')
    return null
  }
}

/** List a directory, treating a failure as "empty" and recording it, so the reader never throws. */
async function safeList(
  repo: RepoFiles,
  path: string,
  ref: string,
  log: IssueLog,
): Promise<RepoContentEntry[]> {
  try {
    return await repo.listDirectory(path, ref)
  } catch {
    log.add(path, 'read_failed')
    return []
  }
}

/**
 * Read the presence anchor, keeping "absent" and "the provider refused to answer" apart.
 *
 * The one read in this file that does NOT collapse to null, because it is the one whose failure
 * mode is a lie rather than a gap: every other file merely thins the tree, while an unread anchor
 * ends the walk and reports a service with no requirements at all.
 */
async function getAnchorFile(
  repo: RepoFiles,
  ref: string,
  log: IssueLog,
): Promise<{ status: 'ok'; file: RepoFileContent } | { status: 'absent' | 'read_failed' }> {
  try {
    const file = await repo.getFile(SPEC_SERVICE_PATH, ref)
    return file ? { status: 'ok', file } : { status: 'absent' }
  } catch {
    log.add(SPEC_SERVICE_PATH, 'read_failed')
    return { status: 'read_failed' }
  }
}

/** The empty view for an anchor that yielded no tree, carrying WHY it yielded none. */
function noSpec(anchor: SpecAnchorState, log: IssueLog): ServiceSpecView {
  return { present: false, spec: null, features: [], diagnostics: { anchor, issues: log.issues } }
}

/** Read + reassemble the spec on `ref` (a branch, tag or sha). Never throws. */
export async function readServiceSpec(repo: RepoFiles, ref: string): Promise<ServiceSpecView> {
  const log = new IssueLog()
  // The presence anchor: no readable object `spec/service.json` ⇒ no spec on this branch. A read
  // that FAILED is not an absent one, so the anchor alone is read through the discriminating
  // helper rather than the null-collapsing one every other read uses.
  const anchorRead = await getAnchorFile(repo, ref, log)
  if (anchorRead.status !== 'ok') return noSpec(anchorRead.status, log)
  const serviceFile = anchorRead.file
  const parsedService = parseJson(serviceFile.content)
  // A non-object anchor (null / array / scalar) is a half-written or corrupt file: no tree to
  // serve, but a repo state somebody has to fix rather than a branch that simply has no spec.
  if (!parsedService || typeof parsedService !== 'object' || Array.isArray(parsedService)) {
    log.add(SPEC_SERVICE_PATH, 'unparsed')
    return noSpec('unparsed', log)
  }
  const service = parsedService as { service?: string; summary?: string }

  // Walk `spec/modules/<moduleSlug>/` — each dir is one module, name-sorted by the writer.
  const moduleDirs = (await safeList(repo, SPEC_MODULES_DIR, ref, log)).filter(
    (e) => e.type === 'dir',
  )
  const moduleSlugToName = new Map<string, string>()
  const groupSlugToName = new Map<string, string>()

  // Phase A: per module, read its `_module.json` (for the display name) and list its shards.
  const moduleInfos = await pMap(
    moduleDirs,
    async (dir) => {
      const slug = dir.name
      const [meta, entries] = await Promise.all([
        safeGetFile(repo, `${dir.path}/_module.json`, ref, log),
        safeList(repo, dir.path, ref, log),
      ])
      const metaObj = (meta ? parseJson(meta.content) : undefined) as
        | { name?: string; summary?: string }
        | undefined
      // Fall back to the slug for a blank name too (not only a missing one): `??` keeps `""`,
      // which then fails the module schema and would silently drop the whole module + its
      // valid groups. A corrupt/half-written `_module.json` should degrade to the slug instead.
      const moduleName = nonEmptyString(metaObj?.name) ?? slug
      moduleSlugToName.set(slug, moduleName)
      // Every `*.json` except `_module.json` is one canonical group shard.
      const shards = entries.filter(
        (e) => e.type === 'file' && e.name.endsWith('.json') && e.name !== '_module.json',
      )
      return { slug, moduleName, summary: metaObj?.summary ?? '', shards }
    },
    { concurrency: READ_CONCURRENCY },
  )

  // Phase B: read every group shard across all modules through one bounded queue (this is the
  // largest fan-out), then validate PER SHARD so a malformed group is dropped, not the tree.
  const shardRefs = moduleInfos.flatMap((m) =>
    m.shards.map((entry) => ({
      moduleSlug: m.slug,
      groupSlug: entry.name.replace(/\.json$/, ''),
      entry,
    })),
  )
  const shardContents = await pMap(
    shardRefs,
    async (s) => ({ ref: s, file: await safeGetFile(repo, s.entry.path, ref, log) }),
    { concurrency: READ_CONCURRENCY },
  )
  const groupsByModule = new Map<string, RequirementGroup[]>()
  for (const { ref: s, file } of shardContents) {
    // A file that failed to READ is already logged; only a file we HELD and could not use is
    // this branch's news, so the unparsed record is conditioned on having content.
    if (!file) continue
    const { group, dropped } = coerceGroupShard(parseJson(file.content))
    if (!group) {
      log.add(s.entry.path, 'unparsed')
      continue
    }
    if (dropped > 0) log.add(s.entry.path, 'partial', dropped)
    groupSlugToName.set(`${s.moduleSlug}/${s.groupSlug}`, group.name)
    const list = groupsByModule.get(s.moduleSlug) ?? []
    list.push(group)
    groupsByModule.set(s.moduleSlug, list)
  }

  const modules = moduleInfos
    .map((m) => ({
      slug: m.slug,
      module: safeParseSpecModule({
        name: m.moduleName,
        summary: m.summary,
        groups: groupsByModule.get(m.slug) ?? [],
      }),
    }))
    .filter((entry): entry is { slug: string; module: SpecModule } => {
      if (entry.module) return true
      // A module whose own record cannot be validated takes its groups with it, so it is named
      // against the folder that held it: dropping it silently is a whole domain vanishing.
      log.add(`${SPEC_MODULES_DIR}/${entry.slug}`, 'unparsed')
      return false
    })
    .map((entry) => entry.module)

  // Build the doc from the per-node-validated pieces directly, so a missing/empty service
  // name (the SPA falls back to the block title) degrades to showing the modules rather than
  // blanking the whole view.
  const spec: SpecDoc = {
    service: typeof service.service === 'string' ? service.service : '',
    summary: typeof service.summary === 'string' ? service.summary : '',
    modules,
  }

  const features = await readFeatureFiles(repo, ref, moduleSlugToName, groupSlugToName, log)

  return { present: true, spec, features, diagnostics: { anchor: 'present', issues: log.issues } }
}

/** Read the seeded Gherkin `.feature` files under `spec/features/<module>/<group>.feature`. */
async function readFeatureFiles(
  repo: RepoFiles,
  ref: string,
  moduleSlugToName: Map<string, string>,
  groupSlugToName: Map<string, string>,
  log: IssueLog,
): Promise<SpecFeatureFile[]> {
  const moduleDirs = (await safeList(repo, SPEC_FEATURES_DIR, ref, log)).filter(
    (e) => e.type === 'dir',
  )
  const perModule = await pMap(
    moduleDirs,
    async (dir) => {
      const entries = await safeList(repo, dir.path, ref, log)
      return entries
        .filter((e) => e.type === 'file' && e.name.endsWith('.feature'))
        .map((entry) => ({ slug: dir.name, entry }))
    },
    { concurrency: READ_CONCURRENCY },
  )
  const featureRefs = perModule.flat()
  const read = await pMap(
    featureRefs,
    async (fr): Promise<SpecFeatureFile | null> => {
      const file = await safeGetFile(repo, fr.entry.path, ref, log)
      if (!file) return null
      const groupSlug = fr.entry.name.replace(/\.feature$/, '')
      return {
        module: moduleSlugToName.get(fr.slug) ?? fr.slug,
        group: groupSlugToName.get(`${fr.slug}/${groupSlug}`) ?? groupSlug,
        path: fr.entry.path,
        content: file.content,
      }
    },
    { concurrency: READ_CONCURRENCY },
  )
  return read.filter((x): x is SpecFeatureFile => x !== null)
}
