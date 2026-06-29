// The project name is interpolated verbatim into the generated `local/`/`frontend/` package
// `name` fields (`<name>-local` / `<name>-frontend`), so it has to be a valid npm package name:
// lowercase, no spaces, and not starting with `.`/`_`. A free-text answer like "My Cats" would
// otherwise produce `"My Cats-local"`, which `npm install` rejects. This coerces any input into a
// safe slug, falling back to a default when nothing usable survives.

/** Coerce arbitrary text into a valid npm-name slug. Returns `fallback` if nothing usable remains. */
export function slugifyProjectName(input: string, fallback = 'cat-factory'): string {
  const slug = input
    .trim()
    .toLowerCase()
    // Anything not a safe npm-name char becomes a hyphen.
    .replace(/[^a-z0-9._-]+/g, '-')
    // Collapse runs of separators, then strip leading/trailing separators and leading `.`/`_`.
    .replace(/-+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
  return slug.length > 0 ? slug : fallback
}
