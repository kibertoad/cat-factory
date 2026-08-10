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
// What is left here is the join, and it has exactly two failure modes worth naming separately:
// a repository this workspace cannot see (created under the wrong account, or outside what a
// GitHub App installation covers), and one that already backs a service (a previous pass, or
// someone else's board). Both read identically from a bare "service creation failed".

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
 */
export function findRepo(
  repos: readonly ListPublicReposResponseRepo[],
  owner: string,
  name: string,
): ListPublicReposResponseRepo | null {
  return (
    repos.find(
      (repo) =>
        repo.name.toLowerCase() === name.toLowerCase() &&
        repo.owner.toLowerCase() === owner.toLowerCase(),
    ) ?? null
  )
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

  if (repo.serviceId) {
    const service = await findServiceById(client, repo.serviceId)
    if (service) {
      journal.say(
        'milestone',
        `'${repo.owner}/${repo.name}' already backs service ${service.serviceId}; adopting it`,
      )
      return recordOf(service, repo)
    }
    // The projection names a frame the board no longer holds. Creating a second service over the
    // same repository is the right move and is what the platform does anyway, so say so rather
    // than refusing: the alternative is a pass that cannot start until someone repairs a row.
    journal.record(
      'milestone',
      `'${repo.owner}/${repo.name}' names service ${repo.serviceId}, which the board no longer ` +
        `lists; creating a fresh frame over the same repository`,
    )
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
