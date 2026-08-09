import type { AddServiceFromRepoInput } from '@cat-factory/contracts'
import { ValidationError } from '@cat-factory/kernel'

// The rules that decide how a NEW service frame is pinned to the repository behind it, extracted
// from `BoardService.addServiceFromRepo` as a cohesive collaborator: pure, so the whole decision
// is settled before the service writes anything.
//
// That ordering is the point of the extraction, not a side effect of it. The create both READS a
// repo-wide flag and WRITES it, so a guard evaluated after the write leaves a refused request
// having already flipped `isMonorepo` — which moves the working directory of every service the
// repository already backs, because `resolveRepoTarget` hands agents a service's subdirectory only
// while the flag is on. Deciding here means the service can write the flag once, after every
// refusal has already had its chance.

/**
 * How a create should treat a repository that ALREADY backs an account-owned service whose frame
 * block is homed on ANOTHER workspace.
 *
 * `mount` shares that service onto this board and answers with the frame homed elsewhere, which is
 * right for the app: the SPA renders a COMPOSED board, so a mounted frame is one of its blocks.
 *
 * `refuse` is for a caller that can only address blocks homed HERE. The public API is the one
 * that exists: every read on it is a workspace-scoped repository read (see `publicBoardReads`), so
 * a foreign-homed frame id would come back from a 201 that no other endpoint on the surface can
 * honour — `GET /api/v1/services` would not list it and `POST /api/v1/services/{id}/tasks` would
 * 404 on it. Answering with an id like that is worse than refusing, because it reads as success.
 */
export type SharedServicePolicy = 'mount' | 'refuse'

/** How this create pins the new service to its repository, once every guard has passed. */
export interface ServiceRepoLinkage {
  /** The repository's monorepo flag as it stands AFTER this create (the request's, or the stored one). */
  isMonorepo: boolean
  /** The normalised subdirectory the service is pinned to; undefined for a whole-repo service. */
  directory: string | undefined
  /** Whether {@link isMonorepo} differs from what is stored, so the projection has to be written. */
  flagChanged: boolean
}

/**
 * Settle the repo linkage a create asks for, or throw the refusal that names what is wrong.
 *
 * Both halves of the monorepo rule are enforced, against the flag as it will stand after the call:
 *
 *  - A monorepo service MUST name a subdirectory, or execution has nothing to scope agents to.
 *  - A whole-repo service must NOT name one. This half was the silent one: `resolveRepoTarget`
 *    reads a service's `directory` only when the repo is a monorepo, so a directory stored against
 *    a whole-repo service is ignored at dispatch and the agents run at the repository root, while
 *    the caller and the created service both say the work is pinned to a subdirectory. Refusing is
 *    the only honest answer, since neither reading of the request can be delivered.
 *
 * The request's own flag is what decides, and its ABSENCE means "leave the repository as it is"
 * rather than "this is not a monorepo": a caller that names a directory without naming the flag is
 * pinning a subdirectory of a repository somebody has already marked as a monorepo, which is the
 * ordinary case, and reading the omission as `false` would refuse it.
 */
export function resolveServiceRepoLinkage(
  input: Pick<AddServiceFromRepoInput, 'directory' | 'isMonorepo'>,
  storedIsMonorepo: boolean,
): ServiceRepoLinkage {
  const isMonorepo = input.isMonorepo ?? storedIsMonorepo
  const directory = normalizeServiceDirectory(input.directory)
  if (isMonorepo && !directory) {
    throw new ValidationError('Select a service directory for this monorepo', {
      reason: 'monorepo_requires_directory',
    })
  }
  if (!isMonorepo && directory) {
    throw new ValidationError(
      'A whole-repo service cannot name a directory; mark the repository as a monorepo to pin a subdirectory',
      { reason: 'directory_requires_monorepo' },
    )
  }
  return { isMonorepo, directory, flagChanged: isMonorepo !== storedIsMonorepo }
}

/**
 * Coerce a user-supplied monorepo service subdirectory into a clean, SAFE relative path
 * (or undefined when absent/empty): normalise separators, drop `.`/empty segments, and
 * reject any `..` segment or absolute path so the stored value can never escape the repo
 * checkout when it later becomes an agent's cwd. Mirrors the harness's `sanitizeService
 * Directory`, kept here so a bad value is rejected before the service row is written.
 */
export function normalizeServiceDirectory(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const segments = raw
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) return undefined
  if (segments.some((s) => s === '..')) {
    throw new ValidationError('Service directory must be a path inside the repository')
  }
  return segments.join('/')
}
