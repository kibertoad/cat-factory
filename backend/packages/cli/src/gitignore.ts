// `.gitignore` management for the scaffolded project. The whole point of writing secrets into
// `.env` is that they must NEVER be committed, so the CLI guarantees the ignore rules are in
// place — creating a `.gitignore` when there is none, or merging the required rules into an
// existing one (e.g. when scaffolding into a directory that is already a git repo).

/** The ignore rules every scaffolded project needs. `.env` secrets first — that's the point. */
export const REQUIRED_GITIGNORE_RULES: readonly string[] = [
  // Secrets — the reason this file exists.
  '.env',
  '.env.*',
  '!.env.example',
  // Dependencies + build output.
  'node_modules/',
  'dist/',
  '*.tsbuildinfo',
  // Nuxt build / generate output.
  '.nuxt',
  '.output',
  // Local Postgres data / captured artifacts.
  '.file-storage/',
]

const HEADER = '# cat-factory (added by `cat-factory init`)'

/**
 * Produce the `.gitignore` content for a freshly scaffolded project. A leading header documents
 * the source; rules follow one per line.
 */
export function buildGitignore(): string {
  return `${HEADER}\n${REQUIRED_GITIGNORE_RULES.join('\n')}\n`
}

/**
 * Merge the {@link REQUIRED_GITIGNORE_RULES} into an EXISTING `.gitignore`, appending only the
 * rules that aren't already present (compared after trimming, ignoring blank/comment lines). The
 * existing content is preserved verbatim; a documented block of the missing rules is appended.
 * Returns the original unchanged when nothing is missing.
 */
export function mergeGitignore(existing: string): string {
  const present = new Set(
    existing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  )
  const missing = REQUIRED_GITIGNORE_RULES.filter((rule) => !present.has(rule))
  if (missing.length === 0) return existing

  const prefix = existing.endsWith('\n') || existing.length === 0 ? existing : `${existing}\n`
  return `${prefix}\n${HEADER}\n${missing.join('\n')}\n`
}
