// What THIS suite's reset targets, and what it leaves behind.
//
// The plan/apply machinery is the kit's (`@cat-factory/acceptance-kit`'s `reset.ts`), which owns the
// four rules that fail quietly: unfinished tasks before their frame, never removing a ledger while a
// frame it names still stands, when the `latest` pointer goes, and applying the PLAN rather than a
// freshly derived target. What is left here is the part no kit can know, and it is the part this
// suite's own refusals are made of.
//
// The refusal this exists for is `target-repos` (and its sibling `board-titles`): a repository that
// already backs a service frame some earlier pass created is refused, because a fresh pass would
// adopt work that is not its own. The remedy has always offered two ways out, RESUME the pass that
// owns it or point the suite at fresh repositories, and a third that was not a command at all:
// "delete the service frame that holds this one". Deleting a frame was an app act, so the one
// instruction an operator running a HEADLESS pass could not carry out headlessly was the one that
// starts over. `DELETE /api/v1/services/{serviceId}` closed that (see `backend/docs/public-api.md`),
// and this is what points the kit's machinery at the right frames.
//
// Two questions, unioned, because the two refusals ask different ones: `target-repos` is about a
// REPOSITORY that is spoken for, and `board-titles` is about a TITLE that is taken. A frame can be
// targeted for either reason (a service whose repository was re-pointed keeps the title; a frame
// renamed by hand keeps the repository), and a plan built from one question alone leaves the other
// refusal firing after a reset reported success.
//
// **What it cannot reclaim is STATED.** A reset that silently leaves two scaffolded repositories, an
// open issue and a cluster namespace behind reads as "the board is clean", and the next pass then
// scaffolds on top of a tree that is already built. That is `leftoversOf` below, and it is the half
// of this file an operator takes most on trust, because they cannot see the repositories from here.

import type {
  LeftoversContext,
  ResetBlocker,
  ResetClient,
  ResetInput,
  ResetPassOnDisk,
  ResetTargeting,
  TargetedFrame,
} from '@cat-factory/acceptance-kit'
import { blockedRepoMessage, sameRepo } from './adopt.ts'
import type { BoardConfig } from './config.ts'
import { serviceTitles } from './instructions.ts'
import type { World } from './world.ts'

/** One row of `GET /api/v1/repos`, narrowed to what decides whether a repository is spoken for. */
export type ResetRepoRow = {
  owner: string
  name: string
  serviceId: string | null
  linkedElsewhere: boolean
}

/**
 * The kit's four calls plus the repository read this suite's own questions need.
 *
 * The kit deliberately does not name this read: which rows decide a target is a fact about ONE
 * suite, and a port that listed them would be describing this one.
 */
export type AcceptanceResetClient = ResetClient & {
  repos(): Promise<readonly ResetRepoRow[]>
}

export type AcceptanceResetOptions = {
  config: BoardConfig
  namedRunId: string | null
  all: boolean
  passes: readonly ResetPassOnDisk<World>[]
  latest: ResetInput<World>['latest']
  /**
   * Whether `--purge-repos` is reclaiming the PROVIDER side in the same invocation.
   *
   * Needed by a plan that makes no provider call, because {@link leftoversOf} states in writing that
   * the two repositories keep their content and that a reporter's issue stays open. Those sentences
   * are the whole reason a cleared board is not read as a fresh one, and the purge makes both false.
   * A leftovers paragraph that is wrong is worse than none.
   */
  purgeProvider?: boolean
}

/**
 * This suite's answers, as the kit's `planReset` takes them.
 *
 * The repository rows are read ONCE, here, rather than inside the two callbacks: the targeting needs
 * them to say what backs each configured repository, and the leftovers need the same rows to name
 * the repositories a plan reaches BEYOND the configured pair. Two reads could disagree, and a
 * cleanup command can afford one serialized round trip to make sure they cannot.
 */
export async function acceptanceResetInput(
  client: AcceptanceResetClient,
  options: AcceptanceResetOptions,
): Promise<ResetInput<World>> {
  const { config } = options
  const repos = await client.repos()
  return {
    namedRunId: options.namedRunId,
    all: options.all,
    passes: options.passes,
    latest: options.latest,
    target: (services) => targetOf(config, repos, services),
    ledgerServiceIds,
    leftovers: (context) =>
      leftoversOf(
        config,
        context,
        extraReposOf(config, repos, context),
        options.purgeProvider === true,
      ),
  }
}

/** The frames this configuration's two questions reach, plus what it could not read or free. */
function targetOf(
  config: BoardConfig,
  repos: readonly ResetRepoRow[],
  services: readonly { serviceId: string; title: string }[],
): ResetTargeting {
  const frames: TargetedFrame[] = []
  const blockers: ResetBlocker[] = []
  const unlinked: string[] = []

  // The repositories this configuration adopts, and whatever backs each one today.
  for (const name of [config.repos.backend, config.repos.frontend]) {
    const row = repos.find((repo) => sameRepo(repo, config.repoOwner, name))
    if (!row) {
      unlinked.push(`${config.repoOwner}/${name}`)
      continue
    }
    const slug = `${row.owner}/${row.name}`
    if (row.serviceId) {
      frames.push({ serviceId: row.serviceId, because: `backs '${slug}'` })
      continue
    }
    // `serviceId: null` WITH `linkedElsewhere` is a frame homed on another board, which has no id
    // this workspace-scoped key could delete. Stated rather than skipped: it is the one blocker a
    // reset cannot clear, and reading it as "nothing to do" is what would send an operator back
    // round the same refusal wondering why the reset changed nothing.
    if (row.linkedElsewhere) {
      blockers.push({ subject: slug, steps: blockedRepoMessage(slug, 'linked-elsewhere') })
    }
  }

  for (const title of Object.values(serviceTitles(config.namePrefix))) {
    for (const service of services.filter((entry) => entry.title === title)) {
      frames.push({ serviceId: service.serviceId, because: `holds the title '${title}'` })
    }
  }

  return { frames, blockers, notes: unlinkedNotes(unlinked) }
}

/**
 * The service ids one ledger names. Total: a ledger recording nothing yet names none.
 *
 * The kit calls this per pass, and it is what a NAMED pass widens the plan by and what the retention
 * rule matches a surviving frame against.
 */
export function ledgerServiceIds(world: World): readonly string[] {
  return [world.backend, world.frontend].flatMap((service) => (service ? [service.serviceId] : []))
}

/**
 * Configured repositories this workspace has not LINKED, so no row says what backs them.
 *
 * Reported rather than passed over, because "nothing on this board backs it" and "this read cannot
 * see it" are different facts and only the first one means a reset has nothing to do. A repository
 * homed on another board of the account and not linked here reads identically to a fresh one from
 * `GET /api/v1/repos`; `target-repos` is what tells those apart, by point-reading
 * `/repos/available`, and it refuses with the steps. Saying so keeps a plan that clears nothing from
 * reading as a board that is already clean.
 */
function unlinkedNotes(unlinked: readonly string[]): readonly string[] {
  if (unlinked.length === 0) return []
  return [
    `Not linked to this workspace, so GET /api/v1/repos says nothing about what backs ` +
      `${unlinked.length === 1 ? 'it' : 'them'}: ${unlinked.join(', ')}. Nothing here needs ` +
      `clearing for ${unlinked.length === 1 ? 'it' : 'them'}; scenario 01 adopts a reachable ` +
      `repository itself, and if one is spoken for on ANOTHER board the target-repos gate is what ` +
      `says so.`,
  ]
}

/**
 * Repositories a frame in this plan backs BEYOND the two this configuration names.
 *
 * Read off the same `GET /api/v1/repos` rows the plan was built from. They keep their content
 * exactly as the configured pair does, and nothing else in the report would say so: the leftovers
 * paragraph names the pair from the `.env`, which under `--all` is a fraction of what was just
 * emptied. Reachable in the narrow scope too, since a frame can be in the plan for its TITLE while
 * backing some repository this `.env` never mentions.
 */
function extraReposOf(
  config: BoardConfig,
  repos: readonly ResetRepoRow[],
  context: LeftoversContext<World>,
): readonly string[] {
  const doomed = new Set(context.frames.map((frame) => frame.serviceId))
  return repos
    .filter((repo) => repo.serviceId !== null && doomed.has(repo.serviceId))
    .filter(
      (repo) =>
        !sameRepo(repo, config.repoOwner, config.repos.backend) &&
        !sameRepo(repo, config.repoOwner, config.repos.frontend),
    )
    .map((repo) => `${repo.owner}/${repo.name}`)
}

/**
 * What a reset leaves behind, always stated.
 *
 * Every entry here is something an `/api/v1` key cannot reclaim, and each one changes what the next
 * pass does. The repositories are the load-bearing one: `target-repos` says outright that it cannot
 * read whether a repository is EMPTY, so a board reset against two scaffolded repositories passes
 * every prerequisite and then runs a scaffold on top of a tree that is already built.
 */
function leftoversOf(
  config: BoardConfig,
  context: LeftoversContext<World>,
  extraRepos: readonly string[],
  purgeProvider: boolean,
): readonly string[] {
  // Off the ledger's own facts rather than looked up again: deleting the ledger is what makes the
  // issue unrecoverable, so the plan is the last moment anything knows the URL.
  const issues = context.passes.flatMap((pass) => {
    const url = pass.facts?.intakeIssue?.url
    return url ? [`${pass.runId}: ${url}`] : []
  })
  // With `--purge-repos` the two sentences below are the ones this run is actively disproving, so
  // they are replaced rather than softened: the repository half is reported by the purge itself,
  // recovery command included, and repeating "it keeps its content" beside that would contradict it.
  if (purgeProvider) {
    return [
      // The purge only ever touches the two repositories the `.env` names, so under `--all` this is
      // the ONE thing about repositories that is still unreclaimed, and dropping it here would let a
      // purge report be read as covering every repository the plan just deleted a frame for.
      ...(extraRepos.length > 0
        ? [
            `${extraRepos.join(', ')} ${extraRepos.length === 1 ? 'backs a frame' : 'back frames'} ` +
              `this plan deletes and ${extraRepos.length === 1 ? 'is' : 'are'} NOT purged: ` +
              `--purge-repos empties only the two repositories this configuration points at. ` +
              `${extraRepos.length === 1 ? 'It keeps its' : 'They keep their'} content, branches ` +
              `and open pull requests.`,
          ]
        : []),
      `Whatever a purged repository held is in its own history, NOT here: the purge commits on top ` +
        `of the previous tip and tags every ref it touches, so the recovery command it prints is ` +
        `the authority on putting one back.`,
      NAMESPACE_LEFTOVER,
    ]
  }
  return [
    ...(extraRepos.length > 0
      ? [
          `${extraRepos.join(', ')} ${extraRepos.length === 1 ? 'backs a frame' : 'back frames'} ` +
            `this plan deletes and ${extraRepos.length === 1 ? 'keeps its' : 'keep their'} content ` +
            `too. The paragraph below names only the two repositories this configuration points at, ` +
            `which is not the same set once a plan reaches frames it never adopted.`,
        ]
      : []),
    `The two repositories keep their CONTENT. ` +
      `'${config.repoOwner}/${config.repos.backend}' and ` +
      `'${config.repoOwner}/${config.repos.frontend}' still hold whatever a previous pass ` +
      `scaffolded, plus its branches and open pull requests, and no /api/v1 call can empty them. ` +
      `A fresh pass scaffolds ON TOP of that, which is a strange result rather than a failure: ` +
      `empty them yourself (or point ACCEPTANCE_BACKEND_REPO / ACCEPTANCE_FRONTEND_REPO at two ` +
      `fresh repositories) if you want the pass a first run would have.`,
    ...(issues.length > 0
      ? [
          issues.length === 1
            ? `The issue scenario 04 filed as the REPORTER stays open on the provider, because it was ` +
              `never the platform's to close: ${issues[0]}. Close it with the account that filed it.`
            : `The ${issues.length} issues scenario 04 filed as the REPORTER stay open on the ` +
              `provider, because they were never the platform's to close: ${issues.join('; ')}. ` +
              `Close them with the account that filed them.`,
        ]
      : []),
    NAMESPACE_LEFTOVER,
  ]
}

/** The one leftover both branches state, so they cannot come to word it differently. */
const NAMESPACE_LEFTOVER =
  `Per-PR namespaces on the cluster (ACCEPTANCE_K3S_NAMESPACE_TEMPLATE) are not touched. A run ` +
  `that finished reclaimed its own; one that was killed may have left a namespace behind, and ` +
  `only kubectl can see which.`
