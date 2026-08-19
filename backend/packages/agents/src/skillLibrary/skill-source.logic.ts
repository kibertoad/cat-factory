import { parseSimpleYaml, splitFrontmatter, str } from '../repoSourceSync/frontmatter.js'

// Pure logic for repo-sourced Claude skills (ADR 0024):
// parse a `SKILL.md` manifest (YAML frontmatter `name`/`description` + a markdown
// body of instructions) and the small helpers the sync flow needs. No I/O lives
// here so it is unit-testable. Staleness is a commit-sha probe (see
// SkillSourceService), handled by the shared repo-source engine.

/** A skill parsed from a `SKILL.md` manifest's frontmatter + body. */
export interface ParsedSkillManifest {
  name: string
  description: string
  /**
   * The `group:` the frontmatter declared, lowercased and trimmed, or `other` when it declared
   * none. Kept RAW (not narrowed to the wire vocabulary) so a value this build does not know
   * survives to the management surface, which shows the author what they actually wrote instead of
   * a silent reclassification. See `normalizeSkillGroup` in `@cat-factory/contracts`.
   */
  group: string
  /** The procedural instructions (the markdown body). */
  instructions: string
}

/** The shelf a manifest that declares no `group:` lands on. */
const DEFAULT_SKILL_GROUP = 'other'

/** Longest declared group we keep; anything longer is a paste, not a shelf name. */
const MAX_GROUP_LENGTH = 40

/** Slug a skill DIRECTORY name into a stable, id-safe token (`Bug Triage` → `bug-triage`). */
export function slugFromDirName(dirName: string): string {
  return (
    dirName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  )
}

/** Whether a directory listing entry is a `SKILL.md` manifest (case-insensitive). */
export function isSkillManifest(name: string): boolean {
  return /^skill\.md$/i.test(name)
}

/**
 * Parse a `SKILL.md` file. Frontmatter carries `name`, `description` and an optional `group`;
 * the markdown body is the instructions. Tolerant, mirroring the fragment parser: a missing name
 * defaults to a humanised directory name and a missing description to the first body
 * line, so a sparse manifest still imports. Returns null only when there is no usable
 * body at all — an empty `SKILL.md` is not a skill, and returning null keeps the prior
 * synced row alive rather than retiring a skill over an in-progress edit.
 */
export function parseSkillManifest(dirName: string, content: string): ParsedSkillManifest | null {
  const { frontmatter, body } = splitFrontmatter(content)
  const fm = parseSimpleYaml(frontmatter)
  const instructions = body.trim()
  if (!instructions) return null
  const name = str(fm.name) ?? humanise(dirName)
  const description = str(fm.description) ?? firstLine(instructions) ?? name
  return { name, description, group: parseGroup(fm.group), instructions }
}

// --- internals ------------------------------------------------------------

/**
 * The declared group, folded to the case-insensitive form the catalog compares on. An absent or
 * blank declaration is the default shelf; anything else is kept as written (bounded), so an
 * unrecognised value can be shown back to its author rather than disappearing into the default.
 */
function parseGroup(raw: unknown): string {
  const declared = str(raw)?.toLowerCase()
  return declared ? declared.slice(0, MAX_GROUP_LENGTH) : DEFAULT_SKILL_GROUP
}

function firstLine(body: string): string | undefined {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>\-*\s]+/, '').trim())
    .find((l) => l.length > 0)
  return line ? line.slice(0, 200) : undefined
}

function humanise(dirName: string): string {
  const stem = dirName.replace(/[-_]+/g, ' ').trim()
  return stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : 'Skill'
}
