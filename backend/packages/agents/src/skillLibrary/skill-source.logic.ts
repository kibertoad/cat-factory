import { parseSimpleYaml, splitFrontmatter, str } from '../repoSourceSync/frontmatter.js'

// Pure logic for repo-sourced Claude skills (docs/initiatives/repo-skills.md):
// parse a `SKILL.md` manifest (YAML frontmatter `name`/`description` + a markdown
// body of instructions) and the small helpers the sync flow needs. No I/O lives
// here so it is unit-testable. Staleness is a commit-sha probe (see
// SkillSourceService), handled by the shared repo-source engine.

/** A skill parsed from a `SKILL.md` manifest's frontmatter + body. */
export interface ParsedSkillManifest {
  name: string
  description: string
  /** The procedural instructions (the markdown body). */
  instructions: string
}

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
 * Parse a `SKILL.md` file. Frontmatter carries `name` + `description`; the markdown
 * body is the instructions. Tolerant, mirroring the fragment parser: a missing name
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
  return { name, description, instructions }
}

// --- internals ------------------------------------------------------------

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
