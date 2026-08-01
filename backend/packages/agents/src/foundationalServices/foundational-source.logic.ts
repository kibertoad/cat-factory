import { parseSimpleYaml, splitFrontmatter } from '../repoSourceSync/frontmatter.js'

// ---------------------------------------------------------------------------
// Pure parsing rules for repo-sourced foundational services
// (backend/docs/adr/0031-foundational-services.md). A `directory` source treats every
// immediate subdirectory of its `dirPath` as one service, described by a
// `service.md` whose YAML frontmatter carries the identity and whose body is the
// general description; the contract documents sit beside it. A `files` source has
// no directory convention to read identity from, so the LINK supplies it and this
// module only maps the linked paths to contract ids.
//
// No I/O, so every rule is unit-testable and both facades behave identically.
// ---------------------------------------------------------------------------

/** The manifest file naming a service inside a `directory`-mode source. */
export const SERVICE_MANIFEST_FILE = 'service.md'

/** The parsed identity half of a `service.md`. */
export interface ParsedServiceManifest {
  name: string
  summary: string
  capabilities: string[]
  description: string
}

/**
 * Parse a `service.md`. Returns null when it carries no `name` — an unnamed manifest
 * cannot be presented to a design agent as a service to consume, and inventing a name
 * from the directory would hand the Architect a service nobody described.
 *
 * The `id` is deliberately NOT read from frontmatter: it comes from the directory name, so
 * a service's id is visible in the repo tree and a rename is a real (tombstoning) rename
 * rather than two rows silently claiming the same id from different folders.
 */
export function parseServiceManifest(content: string): ParsedServiceManifest | null {
  const { frontmatter, body } = splitFrontmatter(content)
  const meta = parseSimpleYaml(frontmatter)
  const name = str(meta.name)
  if (!name) return null
  return {
    name,
    summary: str(meta.summary) || str(meta.description) || name,
    capabilities: strList(meta.capabilities),
    description: body.trim(),
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * The service id a source directory yields: the directory name lower-kebabed. Same rule the
 * skill library applies to its own directories, so a team that already ships one repo-sourced
 * library does not learn a second slugging convention.
 */
export function slugFromDirName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'service'
  )
}

/**
 * The contract id one contract FILE yields: its basename without extension, lower-kebabed.
 * Stable across a body edit (so an updated spec keeps its id) and changing on a rename
 * (so a renamed file replaces rather than duplicates, because the whole set is replaced).
 */
export function contractIdFromPath(path: string): string {
  const base = path.split('/').pop() ?? path
  return slugFromDirName(base.replace(/\.[^.]+$/, ''))
}

/**
 * A human title for a contract file, derived from its path. Used only when the document
 * itself offers none (the TypeScript formats never do; an OpenAPI document's `info.title` is
 * preferred by the caller).
 */
export function contractTitleFromPath(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * The deepest directory that contains every one of `paths` — where a `files`-mode source
 * anchors its head-commit probe. One probe over the common ancestor detects a change to ANY
 * of the linked files, which is what keeps a multi-file link at one cheap read per staleness
 * check instead of one per file.
 *
 * Falls back to `''` (the repo root) when the paths share no directory, which is correct
 * rather than merely safe: the probe then tracks the repo head, so it can only ever be too
 * eager, never miss a change.
 */
export function commonDirectory(paths: string[]): string {
  const segmented = paths.map((p) => p.split('/').slice(0, -1))
  if (segmented.length === 0) return ''
  const first = segmented[0] ?? []
  const common: string[] = []
  for (let i = 0; i < first.length; i++) {
    const segment = first[i]
    if (segmented.every((parts) => parts[i] === segment)) common.push(segment as string)
    else break
  }
  return common.join('/')
}

/** Strip a leading `./` and any leading/trailing slashes from a repo-relative path. */
export function normalizeFilePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
}
