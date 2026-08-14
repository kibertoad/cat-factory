// Adopting an OPERATOR-CREATED repository as a board service.
//
// This module replaced the bootstrap wait. Repository creation is the one setup step the suite
// cannot perform: a PAT connection reports `canCreateRepos: false`, and the App path creates only
// under `/orgs/{org}/repos`, so a personal account was never a supported target. The decision
// (`backend/docs/adr/0056-acceptance-suite-operator-setup.md`) is that the operator creates the two
// repositories and the suite adopts them, which needs no platform change at all:
// `POST /api/v1/services` already backs a service with an existing repository by `repoId`, and
// `GET /api/v1/repos` is where a `repoId` comes from.
//
// What is left here is the join, and it has four failure modes worth naming separately: a repository
// the connection cannot REACH, one that already backs a service on THIS board, one whose service is
// homed on ANOTHER board of the account, and one whose `serviceId` names a frame the board no longer
// lists. All four read identically from a bare "service creation failed".
//
// **A repository this workspace has not LINKED is not one of them: this module links it.**
// `GET /api/v1/repos` serves the LINKED-repository projection, and linking is a separate act nothing
// performs on its own, so a repository that exists and is reachable is absent from that read until
// someone adopts it. `POST /api/v1/repos/link` is that act on the public surface, so the suite does it
// rather than asking an operator to open the app: a `.env` written by hand and one written by
// `configure` then get the same pass. What is left to a person is what no API can do for them, which
// is why `unreachableRepoSteps` is about EXISTENCE and ACCESS and nothing else.

import { CatFactoryNotFoundError } from '@cat-factory/sdk'

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
  return repos.find((repo) => sameRepo(repo, owner, name)) ?? null
}

/**
 * Whether one row IS the named repository, case-insensitively on both halves.
 *
 * Exported beside {@link findRepo} because a caller that has already found (or failed to find) a row
 * still has to compare others against the same target, and a hand-rolled `===` at that call site is
 * how one of the two comparisons quietly becomes case-sensitive.
 */
export function sameRepo(
  repo: { owner: string; name: string },
  owner: string,
  name: string,
): boolean {
  return (
    repo.name.toLowerCase() === name.toLowerCase() &&
    repo.owner.toLowerCase() === owner.toLowerCase()
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
 * Adopt a repository this workspace has not linked yet, or refuse with what a person has to fix.
 *
 * The suite's own use of `POST /api/v1/repos/link`, and the reason a hand-written `.env` needs no
 * trip through the app: linking is idempotent, so calling it is also the cheapest way to ASK whether
 * the connection can reach the repository at all. One refusal matters here and it covers two causes
 * on purpose (no such repository, or a credential not granted it), which is why the message carries
 * both rather than picking one.
 *
 * Any other failure propagates untouched. A 503 from an unwired module and a 500 from a provider
 * outage are facts about the DEPLOYMENT, and dressing either as "create the repository" would send an
 * operator to fix something that is not broken.
 */
async function linkRepo(options: AdoptOptions): Promise<ListPublicReposResponseRepo> {
  const { client, journal, repoName, repoOwner } = options
  const slug = `${repoOwner}/${repoName}`
  try {
    const linked = await client.repos.link({ owner: repoOwner, name: repoName })
    journal.say('milestone', `linked ${slug} to the workspace (it was reachable but not adopted)`)
    return linked
  } catch (error) {
    if (!isRepoUnreachable(error)) throw error
    throw new Error(unreachableRepoMessage(repoOwner, repoName))
  }
}

/**
 * Whether a failed link means the connection cannot REACH the repository.
 *
 * Read off `details.reason`, not off the 404 alone. The status is shared by an answer that means
 * something else entirely: a deployment predating this endpoint has no route mounted at
 * `/api/v1/repos/link`, and Hono's unmatched-route 404 arrives at the SDK as the same class. Told
 * apart by status, that reads as "the repository does not exist" and sends an operator to create one
 * they already have, over and over, which is exactly the loop this whole module exists to end.
 *
 * `repo_not_reachable` is the surface's own vocabulary and its stability is what makes this safe to
 * branch on; anything else with that status propagates, and the caller reports it as the deployment
 * fault it is.
 */
export function isRepoUnreachable(error: unknown): boolean {
  if (!(error instanceof CatFactoryNotFoundError)) return false
  const details: unknown = error.details
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as { reason?: unknown }).reason === 'repo_not_reachable'
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
  const repo = findRepo(repos, repoOwner, repoName) ?? (await linkRepo(options))

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
    `'${slug}' already backs a whole-repo service this workspace-scoped read cannot name, so ` +
      `POST /api/v1/services will refuse it (reason: repo_service_homed_elsewhere).`,
    `GET /api/v1/repos reports that as \`linkedElsewhere: true\` with \`serviceId: null\`: the ` +
      `frame exists but has no id this key could address, which is why the id is withheld rather ` +
      `than handed back. Reading only \`serviceId\` reads the row as available.`,
    // TWO states answer identically here, and they have opposite fixes, so neither may be
    // asserted as the diagnosis. `linkedElsewhere` is computed against the frames this board
    // VISIBLY lists, and an archived frame is not one of them, so a service archived on THIS
    // board reads exactly like one homed on somebody else's. Naming only the second sends an
    // operator to a board that does not exist.
    `Either it is homed on ANOTHER board of this account: run the pass from the board that HOMES ` +
      `that service (or with a key scoped to it), or point the suite at a repository no service ` +
      `holds.`,
    `Or it backs a frame on THIS board that has been ARCHIVED, which is not listed and has no id ` +
      `to delete: restore it in the app (and reset again), or delete it there, which is what ` +
      `releases the repository projection. /api/v1 publishes neither archive nor restore.`,
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
 * What a repository read actually returned, as one sentence.
 *
 * The list is the whole value: "no repositories at all" and "nine, none of them yours" are different
 * facts about the credential and send an operator to different screens, and a count alone states
 * neither. Used for both repository reads, because both have the same trap.
 *
 * Capped, and the cap SAYS what it dropped: a connection can reach hundreds, and a reader who assumed
 * a complete list would conclude the missing one is missing from the installation too.
 */
export function describeVisibleRepos(
  repos: readonly { owner: string; name: string }[],
  limit = 12,
): string {
  if (repos.length === 0) return 'no repositories at all'
  const slugs = repos.map((repo) => `${repo.owner}/${repo.name}`)
  const shown = slugs.slice(0, limit)
  const dropped = slugs.length - shown.length
  const tail = dropped > 0 ? `, and ${dropped} more not listed here` : ''
  return (
    `${slugs.length} ${slugs.length === 1 ? 'repository' : 'repositories'} ` +
    `(${shown.join(', ')}${tail})`
  )
}

/**
 * How the workspace authenticates to its provider, where that changes what to check.
 *
 * `GET /api/v1/vcs/connection` publishes it, and the two answers send an operator to different
 * screens: an installation's repository ACCESS list, or a token's scopes. Null is a real value
 * (nothing read it) rather than a default, so a caller that did not ask gets BOTH cases named
 * instead of the wrong one.
 */
export type VcsAccessMethod = 'app' | 'pat'

/**
 * Why the workspace's connection cannot REACH a configured repository: one sentence per step, in the
 * order to work through them.
 *
 * A LIST rather than a paragraph for the same reason {@link blockedRepoMessage} is one: the
 * `target-repos` prerequisite spreads these into its numbered remedy, `configure` prints them under a
 * failed check, and `adoptRepoAsService` joins them into a thrown message. One source, so all three
 * cannot come to disagree about the fix.
 *
 * **Nothing here asks anyone to LINK a repository**, and that is the point: adopting a reachable one
 * is `POST /api/v1/repos/link`, which the suite calls itself. These steps cover only what no API can
 * do on an operator's behalf, which is create the repository and grant the credential access to it.
 * `q` on the available-repos read is the confirming command, because it point-reads the exact slug and
 * so answers reachability rather than linkage.
 */
export function unreachableRepoSteps(
  reachable: readonly { owner: string; name: string }[],
  targets: readonly { owner: string; name: string }[],
  method: VcsAccessMethod | null = null,
): readonly string[] {
  const names = targets.map((target) => `'${target.name}'`).join(' and ')
  const one = targets.length === 1
  const elsewhere = targets.flatMap((target) =>
    reachable
      .filter((repo) => repo.name.toLowerCase() === target.name.toLowerCase())
      .map((repo) => `'${target.name}' under '${repo.owner}'`),
  )
  return [
    `If ${names} ${one ? 'does' : 'do'} not exist yet, create ${one ? 'it' : 'them'} EMPTY except ` +
      `for a README: the scaffold runs open a pull request, which needs a default branch to target, ` +
      `and a repository with no commits has none.`,
    ...accessSteps(method),
    ...(elsewhere.length > 0
      ? [
          `A repository with that name IS reachable: ${elsewhere.join(', ')}. So either ` +
            `ACCEPTANCE_REPO_OWNER names the wrong account, or the repository was created under ` +
            `the wrong one.`,
        ]
      : []),
    `Nothing needs linking by hand: the suite adopts a reachable repository itself through ` +
      `POST /api/v1/repos/link, and that call is also what reported this, so a repository this ` +
      `credential can reach is one the pass can use.`,
  ]
}

/**
 * What has to be true of the CONNECTION for the picker to offer the repository at all.
 *
 * Split by `method` where it is known, because the fixes are on different screens and a message
 * naming both makes the reader work out which half is theirs. Unknown names both, which is honest:
 * a caller that never read the connection has no business asserting how this workspace authenticates.
 */
function accessSteps(method: VcsAccessMethod | null): readonly string[] {
  const app =
    `the App installation must INCLUDE the repository: on an "Only select repositories" ` +
    `installation a repository created afterwards is not covered until it is added, and a private ` +
    `repository outside the installation is invisible to the platform exactly as a non-existent one is`
  const pat =
    `the token must be able to see it: a GitHub classic PAT needs \`repo\` for a PRIVATE ` +
    `repository (GitLab: \`api\`), and a token's scopes cannot be widened in place, so re-mint it ` +
    `and paste the new one under Integrations`
  if (method !== null)
    return [`Check what the connection can reach: ${method === 'app' ? app : pat}.`]
  return [
    `If this workspace connects with an app installation, ${app}.`,
    `If with a pasted token, ${pat}.`,
  ]
}

/**
 * Why a configured repository could not be adopted, and what a person has to do about it.
 *
 * Thrown from inside a pass, where the gate has already passed once, so this is a repository that
 * went away (or a `.env` edited mid-pass) rather than a setup that was never done. It carries the full
 * remedy even so: the operator reading it is the one who has to fix it, and a message that names the
 * problem without the fix sends them off to find the instructions.
 *
 * It does NOT list what the connection can reach, unlike the gate's version. Getting that list is a
 * second provider round trip, and this path has already had its answer from the link call: the useful
 * difference between the two surfaces is that the gate runs before anything is spent and can afford
 * to enumerate, where this one is a run that is already going.
 */
function unreachableRepoMessage(owner: string, name: string): string {
  return [
    `POST /api/v1/repos/link could not reach '${owner}/${name}' (404 repo_not_reachable), so ` +
      `there is nothing to adopt: either it does not exist, or this workspace's credential is not ` +
      `granted it.`,
    ...unreachableRepoSteps([], [{ owner, name }]),
    '`pnpm --filter @cat-factory/acceptance run configure` walks the creation and re-checks, and ' +
      '`GET /api/v1/repos/available?q=' +
      `${owner}/${name}` +
      '` answers reachability on its own.',
  ].join('\n  ')
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
