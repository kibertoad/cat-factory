// Detection for `check-release-versions.mjs`: which packages a branch re-versions, and which of
// those numbers the registry has already handed to someone else. Split from the runner so it is
// testable without git or a network (`scripts/release-versions.test.mjs`), the same split as
// `silent-catch.mjs` / `test-lane-parity.mjs`.
//
// The failure it exists to stop. `changeset publish` treats "that version is already on the
// registry" as a WARN and exits 0, and it says that about every package the release did not bump,
// so the message is routine and nobody reads it. On a COLLISION it means the opposite: the version
// was never published, and everything released beside it pins a copy this repo did not build.
//
// That shipped on 2026-08-06. `@cat-factory/prompt-fragments` took its first major bump onto 1.0.0,
// a number a hand-run 2026-06-17 publish had already parked an unbuilt shell on, so the real 1.0.0
// was skipped while `agents` / `orchestration` / `worker` / `node-server` / `local-server` all
// published pinned EXACTLY to it (a `workspace:*` dependency publishes as an exact version).
// Installing any of them resolved a package with no `dist/`, and CI was green throughout.
//
// The question is only answerable BEFORE the publish, which is why this reads a branch rather than
// changesets' output: at publish time "this version is on npm" describes the collision and the two
// dozen unbumped packages identically, but on the Release PR the set of packages whose version
// CHANGED is exactly the set that must not already exist.
//
// `check-publish-integrity.mjs` cannot see any of this: it guards the artifact we BUILT, and here
// the build was fine. What was wrong was whose copy the registry kept at that number.

/**
 * The publishable packages whose version this branch changes, as `{ name, version }`.
 *
 * `entries` are `{ path, head, base }`, the parsed package.json on each side (`null` where the file
 * does not exist). A package ADDED by the branch counts: a brand new folder at the scaffold's
 * default version is exactly how a name gets published onto a number someone else already used.
 */
export function changedVersions(entries) {
  const changed = []
  for (const { path, head, base } of entries) {
    if (!head || head.private || !head.name || !head.version) continue
    if (base && base.version === head.version) continue
    changed.push({ name: head.name, version: head.version, path })
  }
  return changed.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The subset of `changed` whose version the registry already holds.
 *
 * `publishedVersions` maps a package name to the versions the registry lists for it (an empty array
 * for a name that has never been published).
 */
export function collisions(changed, publishedVersions) {
  return changed.filter((entry) =>
    (publishedVersions.get(entry.name) ?? []).includes(entry.version),
  )
}

/** The operator-facing failure text. */
export function formatCollisions(found) {
  return [
    `${found.length} package version(s) in this branch are ALREADY on the npm registry:`,
    ...found.map((entry) => `  ${entry.name}@${entry.version}  (${entry.path})`),
    '',
    'Publishing will not overwrite them. `changeset publish` warns and exits 0, so the release goes',
    'green having shipped every OTHER package pinned to a version this repo never built, and the',
    'first sign of it is a consumer whose install resolves an empty package.',
    '',
    'Move PAST the occupied number: a patch changeset on the colliding package bumps it and',
    'cascades the corrected pin to every dependent. The number itself is spent for good, and',
    'unpublishing does not free it. docs/internal/releases.md lists the ones already burned.',
  ].join('\n')
}
