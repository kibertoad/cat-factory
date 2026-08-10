// Adopting an OPERATOR-CREATED repository as a board service.
//
// This module replaced the bootstrap wait. Repository creation is the one setup step the suite
// cannot perform: a PAT connection reports `canCreateRepos: false`, and the App path creates only
// under `/orgs/{org}/repos`, so a personal account was never a supported target. The decision
// (`docs/initiatives/acceptance-suite-operator-setup.md`) is that the operator creates the two
// repositories and the suite adopts them, which needs no platform change at all:
// `POST /api/v1/services` already backs a service with an existing repository by `repoId`, and
// `GET /api/v1/repos` is where a `repoId` comes from.
//
// What is left here is the join, and it has four failure modes worth naming separately: a repository
// this workspace cannot see (created under the wrong account, or outside what a GitHub App
// installation covers), one that already backs a service on THIS board, one whose service is homed
// on ANOTHER board of the account, and one whose `serviceId` names a frame the board no longer
// lists. All four read identically from a bare "service creation failed".

import type { CatFactoryClient, ListPublicReposResponseRepo, PublicService } from '@cat-factory/sdk'
import type { Journal } from './journal.ts'
import type { ServiceRecord } from './world.ts'

/** The two service shapes this suite adopts, as `POST /api/v1/services` names them. */
export type ServiceType = 'service' | 'frontend'

export type AdoptOptions = {
  client: CatFactoryClient
  journal: Journal
  /** The repository as the operator created it, matched case-insensitively by name. */
  repoName: string
  /** The account it must live under, so a look-alike in another org is refused rather than used. */
  repoOwner: string
  title: string
  type: ServiceType
  description: string
}

/**
 * Find one repository in the workspace's connected set, by name under an owner.
 *
 * Case-insensitive because GitHub and GitLab both treat a repository name that way, so an
 * operator who typed `CF-Acc-Catalog-Api` into the creation form and `cf-acc-catalog-api` into
 * the `.env` has configured one repository rather than two.
 *
 * Generic over the row rather than pinned to the SDK's, so the three callers that need this rule
 * (this module, the `target-repos` prerequisite and `configure`'s visibility loop, the last of
 * which projects the list down to the fields it uses) share ONE copy of it. Two copies of a
 * case-folding rule is two places to forget it.
 */
export function findRepo<T extends { owner: string; name: string }>(
  repos: readonly T[],
  owner: string,
  name: string,
): T | null {
  return (
    repos.find(
      (repo) =>
        repo.name.toLowerCase() === name.toLowerCase() &&
        repo.owner.toLowerCase() === owner.toLowerCase(),
    ) ?? null
  )
}

/**
 * Why a repository cannot be adopted even though the workspace can SEE it, or null.
 *
 * `serviceId: null` alone does not mean "available", and the contract says so outright: a whole-repo
 * service homed on another board of the account has no id this workspace-scoped surface could hand
 * back, so it answers `serviceId: null` WITH `linkedElsewhere: true`. Reading only the id here is
 * how a gate whose whole job is to refuse before spending green-lights a pass that then dies on a
 * `repo_service_homed_elsewhere` 409 out of the first `POST /api/v1/services`.
 *
 * Shared with the `target-repos` prerequisite so the gate and the adopt refuse the same things for
 * the same stated reasons.
 */
export function repoBlocker(
  repo: Pick<ListPublicReposResponseRepo, 'linkedElsewhere' | 'monorepo'>,
): 'linked-elsewhere' | 'monorepo' | null {
  if (repo.linkedElsewhere) return 'linked-elsewhere'
  if (repo.monorepo) return 'monorepo'
  return null
}

/**
 * Back a service with an operator-created repository, or return the one already backing it.
 *
 * Idempotent through the projection rather than through the ledger: the repository row carries the
 * `serviceId` of whatever service already holds it, so a resumed pass re-reads that instead of
 * creating a second frame over the same repository. That is also why this is safe to call before
 * consulting the ledger at all.
 */
export async function adoptRepoAsService(options: AdoptOptions): Promise<ServiceRecord> {
  const { client, journal, repoName, repoOwner, title, type, description } = options
  const { repos } = await client.repos.list()
  const repo = findRepo(repos, repoOwner, repoName)
  if (!repo) {
    throw new Error(missingRepoMessage(repos, repoOwner, repoName))
  }

  const blocker = repoBlocker(repo)
  if (blocker) {
    throw new Error(blockedRepoMessage(`${repo.owner}/${repo.name}`, blocker).join('\n  '))
  }

  if (repo.serviceId) {
    const service = await findServiceById(client, repo.serviceId)
    if (service) {
      journal.say(
        'milestone',
        `'${repo.owner}/${repo.name}' already backs service ${service.serviceId}; adopting it`,
      )
      return recordOf(service, repo)
    }
    // The projection names a frame the board no longer lists (archived, or deleted mid-cascade).
    // Refused rather than worked around, because the work-around does not exist: creating a second
    // service here is not what the platform does. `addServiceFromRepo` looks the repository up
    // ACCOUNT-wide, finds the service the row names, and routes into `mountExistingService`, which
    // raises `This repository is already linked to a board service` for a frame it cannot load. So
    // falling through would spend a round trip to arrive at an opaquer version of this message.
    throw new Error(staleServiceMessage(`${repo.owner}/${repo.name}`, repo.serviceId))
  }

  const service = await client.services.create({
    title,
    type,
    description,
    repo: { repoId: repo.repoId },
  })
  journal.say(
    'milestone',
    `adopted ${repo.owner}/${repo.name} as service ${service.serviceId} ('${title}')`,
  )
  return recordOf(service, repo)
}

/**
 * Why a visible repository is still not adoptable, and what to do instead: one sentence per step.
 *
 * A LIST rather than a paragraph because it has two readers with different shapes. The
 * `target-repos` prerequisite spreads these into its numbered remedy steps, where an embedded
 * newline would break the numbering it renders; this module joins them for a thrown message. One
 * source, so the gate and the adopt cannot come to differ about the fix.
 */
export function blockedRepoMessage(
  slug: string,
  blocker: 'linked-elsewhere' | 'monorepo',
): readonly string[] {
  if (blocker === 'monorepo') {
    return [
      `'${slug}' is registered as a MONOREPO, which backs a service only together with a ` +
        `subdirectory this suite does not configure.`,
      `Point ACCEPTANCE_BACKEND_REPO / ACCEPTANCE_FRONTEND_REPO at two whole-repository targets: ` +
        `the two services here are separate deployable applications with their own Dockerfiles, ` +
        `images and per-PR manifests.`,
    ]
  }
  return [
    `'${slug}' already backs a whole-repo service homed on ANOTHER board of this account, so ` +
      `POST /api/v1/services will refuse it (reason: repo_service_homed_elsewhere).`,
    `GET /api/v1/repos reports that as \`linkedElsewhere: true\` with \`serviceId: null\`: the ` +
      `frame exists but has no id this workspace-scoped key could address, which is why the id is ` +
      `withheld rather than handed back. Reading only \`serviceId\` reads the row as available.`,
    `Run the pass from the board that HOMES that service (or with a key scoped to it), or point ` +
      `the suite at a repository no service holds.`,
  ]
}

/** Why a repository whose `serviceId` names a frame the board no longer lists cannot be adopted. */
export function staleServiceMessage(slug: string, serviceId: string): string {
  return (
    `'${slug}' is linked to service ${serviceId}, which GET /api/v1/services no longer lists ` +
    `(an archived or deleted frame leaves the repository projection pointing at it).\n` +
    `  Adopting it again is not possible from here: POST /api/v1/services finds that same service ` +
    `account-wide and refuses with 'This repository is already linked to a board service' rather ` +
    `than raising a second frame over the repository.\n` +
    `  Restore or fully delete the frame so the projection is released, or point the suite at a ` +
    `fresh empty repository.`
  )
}

/**
 * Why a configured repository is not adoptable, with what the workspace CAN see.
 *
 * The list is the whole value: "no such repository" and "the repository exists but this
 * workspace's connection cannot see it" are the same answer from `GET /api/v1/repos` and need
 * opposite fixes, and the only way to tell them apart from here is to show the operator what did
 * come back.
 */
function missingRepoMessage(
  repos: readonly ListPublicReposResponseRepo[],
  owner: string,
  name: string,
): string {
  const visible = repos.map((repo) => `${repo.owner}/${repo.name}`)
  const sameName = repos.filter((repo) => repo.name.toLowerCase() === name.toLowerCase())
  const elsewhere =
    sameName.length > 0
      ? `\n  A repository called '${name}' IS visible under ${sameName
          .map((repo) => `'${repo.owner}'`)
          .join(', ')}, so either ACCEPTANCE_REPO_OWNER names the wrong account or the ` +
        `repository was created under the wrong one.`
      : ''
  return (
    `GET /api/v1/repos does not list '${owner}/${name}', so there is nothing to adopt.\n` +
    `  Create it (empty, with a README so it has a default branch), and make sure this ` +
    `workspace's connection reaches it: a GitHub App installation must be granted access to that ` +
    `repository, and a PAT must carry \`repo\`.\n` +
    `  Visible to this workspace right now: ${visible.join(', ') || '(none)'}.${elsewhere}\n` +
    `  \`pnpm --filter @cat-factory/acceptance run configure\` opens the creation page prefilled.`
  )
}

/** Read one service frame by id; null when the board no longer lists it. */
async function findServiceById(
  client: CatFactoryClient,
  serviceId: string,
): Promise<PublicService | null> {
  const { services } = await client.services.list()
  return services.find((service) => service.serviceId === serviceId) ?? null
}

function recordOf(service: PublicService, repo: ListPublicReposResponseRepo): ServiceRecord {
  return {
    blockId: service.serviceId,
    serviceId: service.serviceId,
    repoName: `${repo.owner}/${repo.name}`,
  }
}
