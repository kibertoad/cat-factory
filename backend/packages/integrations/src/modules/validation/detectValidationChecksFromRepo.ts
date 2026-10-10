import type { RepoFiles, RepoSurface, ValidationDetectionResult } from '@cat-factory/kernel'
import {
  DEFAULT_VALIDATION_DETECTORS,
  VALIDATION_DETECTION_CONTENT_FILES,
  detectValidationChecks,
} from '@cat-factory/kernel'

/**
 * Read the bounded slice of a repo the pre-PR validation AUTODETECTOR needs, and run the
 * pure kernel rules over it (`docs/initiatives/pre-pr-validation.md`).
 *
 * The read is deliberately shaped as ONE directory listing plus one file read per manifest
 * that the listing PROVED exists — never a blind probe per candidate path. A speculative
 * `getFile` for each of the dozen-odd manifests would be a dozen round trips against every
 * repo, almost all of them 404s, on a button a human presses interactively.
 *
 * Reads go through the checkout-free {@link RepoFiles} port, so this is runtime-symmetric by
 * construction: both facades bind it the same way via `resolveRunRepoContext`, and nothing
 * here touches a filesystem or a database.
 *
 * It does NOT swallow a transport failure. A repo that could not be read must be REPORTED as
 * unread (the caller maps a throw to the `failed` status) rather than returned as "we looked
 * and found nothing" — an operator told the latter would go and configure the checks by hand
 * on the assumption their repo is unrecognised.
 */
export async function detectValidationChecksFromRepo(
  repo: RepoFiles,
  gitRef?: string,
): Promise<ValidationDetectionResult> {
  const entries = await repo.listDirectory('', gitRef)

  // Only fetch a manifest the listing already showed us. Matched case-insensitively, and
  // keyed back by the entry's REAL name so the detectors' own case-insensitive lookups work
  // against whatever spelling the repo uses (`Makefile` vs `makefile`).
  const wanted = new Set(VALIDATION_DETECTION_CONTENT_FILES.map((n) => n.toLowerCase()))
  const toRead = entries.filter((e) => e.type !== 'dir' && wanted.has(e.name.toLowerCase()))

  const contents = await Promise.all(toRead.map((entry) => repo.getFile(entry.path, gitRef)))
  const files: Record<string, string> = {}
  toRead.forEach((entry, index) => {
    const content = contents[index]?.content
    if (content !== undefined) files[entry.name] = content
  })

  const surface: RepoSurface = {
    entries: entries.map((e) => ({ name: e.name, type: e.type })),
    files,
  }
  return detectValidationChecks(surface, DEFAULT_VALIDATION_DETECTORS)
}
