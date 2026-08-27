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
 * Narrow a changeset list to the ones this branch authored.
 *
 * A changeset lives in `.changeset/` from the PR that writes it until a release consumes it, so
 * the working tree of every LATER branch carries it too. Reading the directory therefore answers
 * "what is pending across the repo", while the diff answers "what did this branch do", and mixing
 * the two makes the guard accuse a branch of a bump it never wrote: #2113 landed a justified
 * `@cat-factory/executor-harness` changeset alongside its Dockerfile change, and from that moment
 * every open PR failed the guard on it, because none of them touched the image. A branch with an
 * EMPTY diff failed, which is the shape of the bug: nothing changed, so nothing can be unjustified.
 *
 * Scoping to the diff loses no coverage. The authoring PR is the only place a bad bump is both
 * detectable (its diff is what justifies it) and fixable (the changeset is its own), and a release
 * branch deletes the changesets rather than carrying them, so re-accusing bystanders was never a
 * second line of defence.
 *
 * @param {object} input
 * @param {string[]} input.changesetPaths  repo-relative paths of the changesets on disk
 * @param {string[]} input.changedPaths  repo-relative paths changed against the base ref
 * @returns {string[]} the subset this branch added or edited, in the order given
 */
export function selectAuthoredChangesets({ changesetPaths, changedPaths }) {
  const authored = new Set(changedPaths)
  return changesetPaths.filter((path) => authored.has(path))
}

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
 * @param {object} input
 * @param {Array<{path: string, packages: string[]}>} input.changesets  the changesets this
 *   branch authored, per `selectAuthoredChangesets`: one already on the base ref is not
 *   this branch's to justify
 * @param {Array<{label: string, harnessName: string, image: string, isSource: (path: string) => boolean}>} input.images
 *   one entry per DISTINCT harness package (the executor and executor-ui images share one, so
 *   collapse them before calling: two entries would report the same violation twice)
 * @param {string[]} input.changedPaths  repo-relative paths changed against the base ref
 * @returns {Array<{changeset: string, harnessName: string, message: string}>}
 */
export function findUnjustifiedBumps({ changesets, images, changedPaths }) {
  const violations = []
  for (const image of images) {
    // Computed once per image rather than per changeset: the answer cannot differ between two
    // changesets in the same branch, and the diff is the same list either way.
    const touched = changedPaths.some((path) => image.isSource(path))
    if (touched) continue
    for (const { path, packages } of changesets) {
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
