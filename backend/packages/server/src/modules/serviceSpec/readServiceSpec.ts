import {
  EMPTY_SERVICE_SPEC_VIEW,
  SPEC_FEATURES_DIR,
  SPEC_MODULES_DIR,
  SPEC_SERVICE_PATH,
  safeParseRequirementGroup,
  safeParseSpecModule,
  type RequirementGroup,
  type ServiceSpecView,
  type SpecDoc,
  type SpecFeatureFile,
  type SpecModule,
} from '@cat-factory/contracts'
import type { RepoContentEntry, RepoFiles } from '@cat-factory/kernel'

// Reassemble the SHARDED `spec/` artifact into a single {@link ServiceSpecView} for the
// SPA, reading it checkout-free from the repo's default branch (main) via {@link RepoFiles}.
// The spec-writer harness writes the tree across many files (one canonical JSON shard per
// feature group, plus seeded Gherkin `.feature` files) so concurrent task branches merge
// cleanly; the slugs are filesystem-only (collision-suffixed, name-sorted), so the only way
// to recover the tree is to walk the directories — names live inside the shards, not the
// paths. This is the read-side mirror of the harness's `readExistingSpec`, over HTTP.
//
// Two resilience properties this reader guarantees, so the inspector never sees a 500 or a
// misleading "no spec" state:
//   1. Every repo read is total — a non-404 GitHub error (rate limit, 5xx, network) is
//      treated as "missing" rather than thrown, so a flaky read degrades to a partial view
//      instead of erroring the controller.
//   2. The tree is validated PER NODE — a single malformed module/group shard is dropped,
//      not the whole document, so one bad shard can't blank an otherwise-readable spec.

const EMPTY = EMPTY_SERVICE_SPEC_VIEW

// Cap concurrent GitHub reads so a large spec doesn't fire a burst of dozens of parallel
// requests at once (GitHub flags high concurrency as secondary-rate-limit abuse). The reads
// are still parallel, just bounded.
const READ_CONCURRENCY = 12

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

/** Read a file, treating ANY error (incl. non-404) as "missing" so the reader never throws. */
async function safeGetFile(repo: RepoFiles, path: string, ref: string) {
  try {
    return await repo.getFile(path, ref)
  } catch {
    return null
  }
}

/** List a directory, treating ANY error as "empty" so the reader never throws. */
async function safeList(repo: RepoFiles, path: string, ref: string): Promise<RepoContentEntry[]> {
  try {
    return await repo.listDirectory(path, ref)
  } catch {
    return []
  }
}

/** Map `items` through `fn` with at most `limit` in flight; results preserve input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Read + reassemble the spec on `ref` (the repo default branch). Never throws. */
export async function readServiceSpec(repo: RepoFiles, ref: string): Promise<ServiceSpecView> {
  // The presence anchor: no readable object `spec/service.json` ⇒ no spec on this branch.
  const serviceFile = await safeGetFile(repo, SPEC_SERVICE_PATH, ref)
  if (!serviceFile) return EMPTY
  const parsedService = parseJson(serviceFile.content)
  // A non-object anchor (null / array / scalar) is a half-written or corrupt file — treat as
  // "no spec" rather than reading garbage downstream.
  if (!parsedService || typeof parsedService !== 'object' || Array.isArray(parsedService)) {
    return EMPTY
  }
  const service = parsedService as { service?: string; summary?: string }

  // Walk `spec/modules/<moduleSlug>/` — each dir is one module, name-sorted by the writer.
  const moduleDirs = (await safeList(repo, SPEC_MODULES_DIR, ref)).filter((e) => e.type === 'dir')
  const moduleSlugToName = new Map<string, string>()
  const groupSlugToName = new Map<string, string>()

  // Phase A: per module, read its `_module.json` (for the display name) and list its shards.
  const moduleInfos = await mapLimit(moduleDirs, READ_CONCURRENCY, async (dir) => {
    const slug = dir.name
    const [meta, entries] = await Promise.all([
      safeGetFile(repo, `${dir.path}/_module.json`, ref),
      safeList(repo, dir.path, ref),
    ])
    const metaObj = (meta ? parseJson(meta.content) : undefined) as
      | { name?: string; summary?: string }
      | undefined
    const moduleName = metaObj?.name ?? slug
    moduleSlugToName.set(slug, moduleName)
    // Every `*.json` except `_module.json` is one canonical group shard.
    const shards = entries.filter(
      (e) => e.type === 'file' && e.name.endsWith('.json') && e.name !== '_module.json',
    )
    return { slug, moduleName, summary: metaObj?.summary ?? '', shards }
  })

  // Phase B: read every group shard across all modules through one bounded queue (this is the
  // largest fan-out), then validate PER SHARD so a malformed group is dropped, not the tree.
  const shardRefs = moduleInfos.flatMap((m) =>
    m.shards.map((entry) => ({
      moduleSlug: m.slug,
      groupSlug: entry.name.replace(/\.json$/, ''),
      entry,
    })),
  )
  const shardContents = await mapLimit(shardRefs, READ_CONCURRENCY, async (s) => ({
    ref: s,
    file: await safeGetFile(repo, s.entry.path, ref),
  }))
  const groupsByModule = new Map<string, RequirementGroup[]>()
  for (const { ref: s, file } of shardContents) {
    const group = file ? safeParseRequirementGroup(parseJson(file.content)) : undefined
    if (!group) continue
    groupSlugToName.set(`${s.moduleSlug}/${s.groupSlug}`, group.name)
    const list = groupsByModule.get(s.moduleSlug) ?? []
    list.push(group)
    groupsByModule.set(s.moduleSlug, list)
  }

  const modules = moduleInfos
    .map((m) =>
      safeParseSpecModule({
        name: m.moduleName,
        summary: m.summary,
        groups: groupsByModule.get(m.slug) ?? [],
      }),
    )
    .filter((m): m is SpecModule => m !== undefined)

  // Build the doc from the per-node-validated pieces directly, so a missing/empty service
  // name (the SPA falls back to the block title) degrades to showing the modules rather than
  // blanking the whole view.
  const spec: SpecDoc = {
    service: typeof service.service === 'string' ? service.service : '',
    summary: typeof service.summary === 'string' ? service.summary : '',
    modules,
  }

  const features = await readFeatureFiles(repo, ref, moduleSlugToName, groupSlugToName)

  return { present: true, spec, features }
}

/** Read the seeded Gherkin `.feature` files under `spec/features/<module>/<group>.feature`. */
async function readFeatureFiles(
  repo: RepoFiles,
  ref: string,
  moduleSlugToName: Map<string, string>,
  groupSlugToName: Map<string, string>,
): Promise<SpecFeatureFile[]> {
  const moduleDirs = (await safeList(repo, SPEC_FEATURES_DIR, ref)).filter((e) => e.type === 'dir')
  const perModule = await mapLimit(moduleDirs, READ_CONCURRENCY, async (dir) => {
    const entries = await safeList(repo, dir.path, ref)
    return entries
      .filter((e) => e.type === 'file' && e.name.endsWith('.feature'))
      .map((entry) => ({ slug: dir.name, entry }))
  })
  const featureRefs = perModule.flat()
  const read = await mapLimit(
    featureRefs,
    READ_CONCURRENCY,
    async (fr): Promise<SpecFeatureFile | null> => {
      const file = await safeGetFile(repo, fr.entry.path, ref)
      if (!file) return null
      const groupSlug = fr.entry.name.replace(/\.feature$/, '')
      return {
        module: moduleSlugToName.get(fr.slug) ?? fr.slug,
        group: groupSlugToName.get(`${fr.slug}/${groupSlug}`) ?? groupSlug,
        path: fr.entry.path,
        content: file.content,
      }
    },
  )
  return read.filter((x): x is SpecFeatureFile => x !== null)
}
