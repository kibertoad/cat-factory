// The detection half of the image-harness changeset guard.
// `check-image-harness-changesets.mjs` is the CLI ci.yml runs.
//
// A harness package's `version` IS the container image tag it publishes
// (scripts/runner-images.mjs holds the mapping, and check-runner-image-tag.mjs keeps every pin
// in lockstep with it). That makes a changeset naming one of those packages a different kind of
// statement from a changeset naming an ordinary library: `changeset version` bumps the version,
// `sync-runner-image-tags.mjs` rolls every deploy pin to the new tag, and a deployment mirroring
// those pins pulls and rolls out an image whose contents did not change.
//
// So the rule this enforces is the CONVERSE of the tag guard's. That one asks "the sources
// changed, did the tag get bumped?". This one asks "the tag is being bumped, did the sources
// change?". Neither implies the other, and only the pair closes the loop.
//
// This is not hypothetical. The 2026-08-25 dependency refresh (#2076) listed
// `@cat-factory/deploy-harness: patch` in a changeset whose own prose said "The deploy image is
// unchanged and stays at 0.2.15", because the changeset was written by listing every workspace
// package rather than the ones that moved. Nothing under backend/internal/deploy-harness/
// changed. Release #2077 consumed it, took the package to 0.2.16, and rolled every
// cat-factory-deploy pin, so the declared supported tag now names an image byte-identical to its
// predecessor. A review caught it, one PR too late to stop it.

/**
 * Package names in a changeset's YAML front matter.
 *
 * The front matter is a `---` fenced block of `'name': bump` lines, so it is read directly rather
 * than through a YAML dependency: this runs in the install-free guard job. Quotes are optional in
 * the format and both forms appear in this repo's history, so both are accepted.
 *
 * @param {string} text  the full .md file contents
 * @returns {string[]} package names, in file order
 */
export function parseChangesetPackages(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return []
  const names = []
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^\s*(['"]?)([^'":]+)\1\s*:\s*\S+\s*$/.exec(line)
    if (entry) names.push(entry[2].trim())
  }
  return names
}

/**
 * Find changesets that version an image harness without changing that image.
 *
 * Only a changeset THIS BRANCH added or edited is judged, which is what the violation message
 * has always claimed ("nothing that goes into that image changed on this branch"). An unreleased
 * changeset inherited from the base sits in `.changeset/` on every branch cut afterwards, and the
 * image change that justified it is behind the merge base, so judging it here asks whether one
 * branch justifies another branch's bump: the answer is no for every PR open at the time, and the
 * guard reddens all of them until the release consumes the changeset. The filter is inside the
 * rule rather than left to the caller because a caller that forgets it fails CLOSED, blocking work
 * that is not its own.
 *
 * @param {object} input
 * @param {Array<{path: string, packages: string[]}>} input.changesets  every changeset present
 * @param {Array<{label: string, harnessName: string, image: string, isSource: (path: string) => boolean}>} input.images
 *   one entry per DISTINCT harness package (the executor and executor-ui images share one, so
 *   collapse them before calling: two entries would report the same violation twice)
 * @param {string[]} input.changedPaths  repo-relative paths changed against the base ref
 * @returns {Array<{changeset: string, harnessName: string, message: string}>}
 */
export function findUnjustifiedBumps({ changesets, images, changedPaths }) {
  const changed = new Set(changedPaths)
  const ownChangesets = changesets.filter((entry) => changed.has(entry.path))
  const violations = []
  for (const image of images) {
    // Computed once per image rather than per changeset: the answer cannot differ between two
    // changesets in the same branch, and the diff is the same list either way.
    const touched = changedPaths.some((path) => image.isSource(path))
    if (touched) continue
    for (const { path, packages } of ownChangesets) {
      if (!packages.includes(image.harnessName)) continue
      violations.push({
        changeset: path,
        harnessName: image.harnessName,
        message:
          `${path} versions "${image.harnessName}", whose version IS the ${image.image} image tag, ` +
          `but nothing that goes into that image changed on this branch. Releasing it would roll ` +
          `every ${image.image} pin to a new tag naming a byte-identical image, and a deployment ` +
          `mirroring those pins would pull and roll out a no-op. Remove the entry, or include the ` +
          `image change that justifies it.`,
      })
    }
  }
  return violations
}
