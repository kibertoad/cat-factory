import {
  SPEC_FEATURES_DIR,
  SPEC_MODULES_DIR,
  SPEC_SERVICE_PATH,
  safeParseSpecDoc,
  type RequirementGroup,
  type ServiceSpecView,
  type SpecDoc,
  type SpecFeatureFile,
  type SpecModule,
} from '@cat-factory/contracts'
import type { RepoFiles } from '@cat-factory/kernel'

// Reassemble the SHARDED `spec/` artifact into a single {@link ServiceSpecView} for the
// SPA, reading it checkout-free from the repo's default branch (main) via {@link RepoFiles}.
// The spec-writer harness writes the tree across many files (one canonical JSON shard per
// feature group, plus seeded Gherkin `.feature` files) so concurrent task branches merge
// cleanly; the slugs are filesystem-only (collision-suffixed, name-sorted), so the only way
// to recover the tree is to walk the directories — names live inside the shards, not the
// paths. This is the read-side mirror of the harness's `readExistingSpec`, over HTTP.

const EMPTY: ServiceSpecView = { present: false, spec: null, features: [] }

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

/** Read + reassemble the spec on `ref` (the repo default branch). Never throws. */
export async function readServiceSpec(repo: RepoFiles, ref: string): Promise<ServiceSpecView> {
  // The presence anchor: no `spec/service.json` ⇒ no spec has been written on this branch.
  const serviceFile = await repo.getFile(SPEC_SERVICE_PATH, ref)
  if (!serviceFile) return EMPTY
  const service = parseJson(serviceFile.content) as
    | { service?: string; summary?: string }
    | undefined
  if (!service) return EMPTY

  // Walk `spec/modules/<moduleSlug>/` — each dir is one module, name-sorted by the writer.
  const moduleDirs = (await repo.listDirectory(SPEC_MODULES_DIR, ref)).filter(
    (e) => e.type === 'dir',
  )
  const moduleSlugToName = new Map<string, string>()
  const groupSlugToName = new Map<string, string>()
  const modules = await Promise.all(
    moduleDirs.map(async (dir): Promise<SpecModule> => {
      const slug = dir.name
      const meta = await repo.getFile(`${dir.path}/_module.json`, ref)
      const metaObj = (meta ? parseJson(meta.content) : undefined) as
        | { name?: string; summary?: string }
        | undefined
      const moduleName = metaObj?.name ?? slug
      moduleSlugToName.set(slug, moduleName)

      // Every `*.json` except `_module.json` is one canonical group shard.
      const shards = (await repo.listDirectory(dir.path, ref)).filter(
        (e) => e.type === 'file' && e.name.endsWith('.json') && e.name !== '_module.json',
      )
      const groups = (
        await Promise.all(
          shards.map(async (shard): Promise<RequirementGroup | null> => {
            const groupSlug = shard.name.replace(/\.json$/, '')
            const file = await repo.getFile(shard.path, ref)
            const group = file
              ? (parseJson(file.content) as RequirementGroup | undefined)
              : undefined
            if (group?.name) groupSlugToName.set(`${slug}/${groupSlug}`, group.name)
            return group ?? null
          }),
        )
      ).filter((g): g is RequirementGroup => g !== null)

      return { name: moduleName, summary: metaObj?.summary ?? '', groups }
    }),
  )

  const assembled = {
    service: service.service ?? '',
    summary: service.summary ?? '',
    modules,
  }
  // Validate the reassembled tree; a malformed shard falls back to an empty (present) view
  // rather than 500-ing the inspector.
  const spec: SpecDoc | undefined = safeParseSpecDoc(assembled)

  const features = await readFeatureFiles(repo, ref, moduleSlugToName, groupSlugToName)

  return { present: true, spec: spec ?? null, features }
}

/** Read the seeded Gherkin `.feature` files under `spec/features/<module>/<group>.feature`. */
async function readFeatureFiles(
  repo: RepoFiles,
  ref: string,
  moduleSlugToName: Map<string, string>,
  groupSlugToName: Map<string, string>,
): Promise<SpecFeatureFile[]> {
  const moduleDirs = (await repo.listDirectory(SPEC_FEATURES_DIR, ref)).filter(
    (e) => e.type === 'dir',
  )
  const nested = await Promise.all(
    moduleDirs.map(async (dir): Promise<SpecFeatureFile[]> => {
      const slug = dir.name
      const moduleName = moduleSlugToName.get(slug) ?? slug
      const files = (await repo.listDirectory(dir.path, ref)).filter(
        (e) => e.type === 'file' && e.name.endsWith('.feature'),
      )
      return (
        await Promise.all(
          files.map(async (f): Promise<SpecFeatureFile | null> => {
            const groupSlug = f.name.replace(/\.feature$/, '')
            const file = await repo.getFile(f.path, ref)
            if (!file) return null
            return {
              module: moduleName,
              group: groupSlugToName.get(`${slug}/${groupSlug}`) ?? groupSlug,
              path: f.path,
              content: file.content,
            }
          }),
        )
      ).filter((x): x is SpecFeatureFile => x !== null)
    }),
  )
  return nested.flat()
}
