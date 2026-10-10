// The names the scaffold derives from the project name answered at setup. Each target has its
// OWN charset rule, and sharing one rule across two of them is how a name that is legal in one
// system silently breaks (or changes meaning) in another:
//
//   - npm package names (`<slug>-local` / `<slug>-frontend` in the generated `package.json`s):
//     lowercase, no spaces, `.` and `_` allowed but never leading. `slugifyProjectName`, the
//     value carried as `BootstrapInput.projectName`.
//   - the Cloudflare Pages project (`frontend/wrangler.toml`): lowercase letters, digits and
//     hyphens only, so the npm slug's `.`/`_` cannot survive. `pagesProjectName`.
//   - the Compose project that keys the deployment's containers and database volume: derived
//     from the deployment DIRECTORY rather than from this slug, so it lives in
//     `composeProject.ts`.
//
// A free-text answer like "My Cats" would otherwise produce `"My Cats-local"`, which
// `npm install` rejects.

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

/**
 * The generated SPA's Cloudflare Pages project name, complete with its suffix so the value is
 * assembled in exactly one place.
 *
 * Pages accepts only lowercase letters, digits and hyphens, which is stricter than the npm slug
 * this narrows: `acme.site` and `my_app` are valid npm names that `wrangler pages deploy`
 * rejects, so leaving them in place ships a deploy target that is dead on arrival.
 *
 * Takes a slug already resolved by {@link slugifyProjectName}, whose first and last characters
 * are therefore `[a-z0-9]`: that is what keeps the narrowed name non-empty and free of the
 * leading/trailing hyphen Pages also refuses.
 */
export function pagesProjectName(projectSlug: string): string {
  const narrowed = projectSlug.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
  return `${narrowed}-frontend`
}
