// `configure`: assemble the suite's `.env` by asking as little as possible.
//
// The suite needs ten variables, two repositories and a cluster, and before this command existed
// the way to arrive at them was to read the README twice and paste values from four places. Most of
// them are not questions at all: the deployment knows its own workspace and connected account, the
// kubeconfig knows the cluster, and the preset library knows what a pass can run on. So the rule
// here is **resolve rather than ask**, and the corollary is that what remains to be asked is worth
// asking properly.
//
//   - **The API token is the one thing nothing can resolve.** No endpoint mints one, so it is asked
//     for, never echoed, and never printed back in the summary (`configureEnv.ts` owns that list).
//   - **The two repository names are the operator's choice**, because the operator creates them
//     (see `adopt.ts`). Having asked, this command ADOPTS each one through
//     `POST /api/v1/repos/link` and reports what that answered, so the two things it cannot do
//     (create a repository, grant a credential access to one) are the only two it asks for.
//   - **Nothing is overwritten silently.** An existing value becomes the prompt's default, and the
//     summary states every key it replaced.
//
// Interactive, so everything it touches is behind a seam: `Io` and `HostShell` are the CLI's own
// (the same ones `cat-factory k3s` is driven by), the file reads/writes are functions, and the
// deployment is a narrow port rather than the SDK client. `test/configure.test.ts` drives the whole
// flow with fakes.

import type { HostShell, Io } from '@cat-factory/cli'
import {
  decodeToken,
  normalizeApiServerUrl,
  readApiServerCommand,
  readTokenCommand,
  runCommand,
} from '@cat-factory/cli'
import {
  CatFactoryClient,
  CatFactoryNotFoundError,
  type PrReportRunProvider,
} from '@cat-factory/sdk'
import {
  blockedRepoMessage,
  repoBlocker,
  unreachableRepoSteps,
  type VcsAccessMethod,
} from './adopt.ts'
import {
  describeEntries,
  describeMerge,
  type ManagedEntry,
  mergeEnvFile,
  readAssignments,
  REPO_CREATION_URL,
} from './configureEnv.ts'
import { formatRemedy } from './preflight.ts'
import { usablePresets } from './presets.ts'

/**
 * What one adopt attempt answered.
 *
 * Two states rather than a nullable row, so a caller cannot read "could not reach it" as "no row yet"
 * and carry on: the first needs a person, the second does not exist as an outcome here.
 */
export type LinkOutcome =
  | {
      status: 'adopted'
      repo: {
        owner: string
        name: string
        serviceId: string | null
        linkedElsewhere: boolean
        monorepo: boolean
      }
    }
  | { status: 'unreachable' }

/** What this command needs from the deployment, narrowed to the six calls it makes. */
export type ConfigureClient = {
  identity(): Promise<{ workspaceId: string; scope: string; label: string }>
  /**
   * The connected account, plus the two things about the connection that shape what this command
   * can say: WHICH platform (so a creation link is offered only where one can be built) and HOW the
   * workspace authenticates (so a repository the picker cannot offer is diagnosed against the right
   * screen: an installation's repository access list, or a token's scopes).
   */
  connection(): Promise<{
    accountLogin: string
    provider: PrReportRunProvider
    method: VcsAccessMethod
  } | null>
  /**
   * Adopt one repository into the workspace, or report that the connection cannot reach it.
   *
   * The command's one WRITE, and it replaced the read it used to make. Listing what the workspace had
   * linked could only ever report a gap: linking is a separate act, so a repository the operator had
   * just created was absent from that list and the command's whole answer was instructions for going
   * and doing it by hand. `POST /api/v1/repos/link` is idempotent, so calling it is both the fix and
   * the cheapest way to ASK whether the repository is reachable at all.
   *
   * `unreachable` is a VALUE rather than a throw because it is the one refusal that is a fact about
   * the repository rather than about the deployment; everything else propagates, so an unwired module
   * or a provider outage is never reported as "create the repository".
   *
   * The row carries what decides whether it can back a service: `linkedElsewhere` and `monorepo` ride
   * along because `serviceId: null` alone does not mean available (a service homed on another board of
   * the account has no id this workspace-scoped surface can hand back, so it answers null WITH the
   * flag set), and projecting the flag away here would report such a repository as ready to use.
   */
  link(owner: string, name: string): Promise<LinkOutcome>
  /**
   * What the connection can REACH for a query, used only to diagnose a repository it cannot.
   *
   * Read on the failure path alone, because on the success path there is nothing left to ask: the
   * adopt already answered. What this adds is the difference between a typo in the owner and a
   * credential that reaches nothing, which is a distinction no other read here can make.
   */
  available(query: string): Promise<readonly { owner: string; name: string }[]>
  presets(): Promise<
    readonly { presetId: string; name: string; baseModelId: string; isDefault: boolean }[]
  >
  models(): Promise<readonly { modelId: string; available: boolean }[]>
}

export type ConfigureDeps = {
  io: Io
  shell: HostShell
  /** The `.env` beside `vitest.acceptance.config.ts`. Absent reads as null, not as an error. */
  envPath: string
  readFile: (path: string) => string | null
  writeFile: (path: string, text: string) => void
  connect: (baseUrl: string, apiKey: string) => ConfigureClient
}

export type ConfigureOutcome = { ok: boolean }

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
const DEFAULT_PREFIX = 'cf-acc'

/**
 * One read's outcome, keeping "answered" apart from "could not be asked".
 *
 * The same three-state rule `preflight.ts` is built on, applied to a command that RESOLVES values
 * rather than grading them: a `.catch(() => null)` here would report an unreachable deployment as a
 * workspace with no VCS connection and an unreadable preset library as an empty one, sending an
 * operator to fix the wrong thing. Every read this command makes is optional (it falls back to
 * asking), so what it owes is an accurate reason.
 */
type Read<T> = { ok: true; value: T } | { ok: false; error: string }

async function read<T>(fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

/**
 * Run the whole flow, returning whether the suite is now configured.
 *
 * `ok: false` is reserved for a `.env` that was NOT written; a written file with a repository still
 * missing is `ok: true` with the gap stated, because the prerequisite gate will name it again with
 * its own remedy and refusing here would throw away nine correct answers over the tenth.
 */
export async function configure(deps: ConfigureDeps): Promise<ConfigureOutcome> {
  const { io, envPath, readFile } = deps
  const existingText = readFile(envPath)
  const previous = existingText === null ? {} : readPrevious(existingText)
  io.info(
    existingText === null
      ? `No ${envPath} yet: every answer below becomes one.`
      : `Reading ${envPath}. Existing values are offered as defaults; press enter to keep one.`,
  )

  const baseUrl = stripTrailingSlash(
    await io.question(
      'Backend origin (serves /api/v1)',
      previous.CAT_FACTORY_BASE_URL ?? DEFAULT_BASE_URL,
    ),
  )
  const apiKey = await resolveApiKey(io, previous.CAT_FACTORY_API_KEY)
  if (!apiKey) {
    io.warn(
      'Without an API token nothing else can be resolved: the workspace id, the connected ' +
        'account, the repository list and the preset library are all key-authenticated reads. ' +
        'Mint one in the SPA (Integrations, "API access tokens", scope "Full access") and re-run.',
    )
    return { ok: false }
  }

  const client = deps.connect(baseUrl, apiKey)
  const read1 = await read(() => client.identity())
  if (!read1.ok) {
    io.warn(
      `GET /api/v1/me failed against ${baseUrl}: ${read1.error}\n` +
        'That is either the wrong origin (the SPA serves a /health of its own, so a base URL ' +
        'pointing at it looks like a broken backend), a deployment that is not running, or a ' +
        'token this deployment does not know. Nothing was written.',
    )
    return { ok: false }
  }
  const identity = read1.value
  io.info(`Resolved workspace ${identity.workspaceId} from the token ('${identity.label}').`)
  if (identity.scope !== 'admin') {
    // Not a refusal: the `.env` is still worth writing, and `api-key` states the same thing with
    // the full remedy. Saying it here is what stops an operator discovering it an hour later.
    io.warn(
      `This token is scoped '${identity.scope}'. The suite needs 'admin': a scope is fixed when a ` +
        'token is created, so mint a new one with "Full access" rather than editing this one.',
    )
  }

  const owner = await resolveOwner(deps, client, previous.ACCEPTANCE_REPO_OWNER)
  if (!owner) {
    io.warn(
      'Without an owner nothing else in this file means anything: the repository list is matched ' +
        'under it, the creation link is built from it, and `resolveConfig` refuses the suite ' +
        'outright when ACCEPTANCE_REPO_OWNER is blank. Nothing was written. Connect the workspace ' +
        '(SPA: Integrations) so this can be resolved, or re-run and name the account.',
    )
    return { ok: false }
  }
  const prefix = await io.question(
    'Name prefix for the board frames and tasks this pass creates',
    previous.ACCEPTANCE_NAME_PREFIX ?? DEFAULT_PREFIX,
  )
  const repos = await resolveRepos(deps, client, { owner, prefix, previous })
  const presetId = await resolvePreset(deps, client, previous.ACCEPTANCE_MODEL_PRESET)
  const cluster = await resolveCluster(deps, previous)

  const entries = buildEntries({
    baseUrl,
    apiKey,
    workspaceId: identity.workspaceId,
    owner: owner.owner,
    prefix,
    repos,
    presetId,
    cluster,
  })
  const merge = mergeEnvFile(existingText, entries)
  deps.writeFile(envPath, merge.text)
  io.info([...describeMerge(merge, envPath), '', ...describeEntries(entries)].join('\n'))
  io.info(
    'Next: `pnpm --filter @cat-factory/acceptance run acceptance`. It runs the prerequisite gate ' +
      'first and refuses, with instructions, before it spends anything.',
  )
  return { ok: true }
}

/**
 * The token: reused without being shown, or asked for.
 *
 * A stored token is never re-displayed, and replacing it is an explicit choice rather than the
 * default: the common re-run of this command is to fix a repository name, and re-pasting a secret
 * to get there is how a working setup gets broken by a typo.
 */
async function resolveApiKey(io: Io, stored: string | undefined): Promise<string> {
  if (stored) {
    const replace = await io.confirm('Replace the stored API token?', false)
    if (!replace) return stored
  }
  return io.secret('Public-API token (cf_live_…, scope "Full access")')
}

/**
 * The account the two repositories live under, plus WHICH platform it is on and HOW it is reached.
 *
 * The provider rides along because it is what decides whether a creation link can be offered at
 * all, and it is null when nothing is connected rather than defaulted: guessing GitHub there would
 * send a GitLab operator to a form on the wrong platform. `method` is null on the same reading: an
 * unresolved connection means nobody read how this workspace authenticates, so the visibility
 * diagnosis names both cases rather than asserting one.
 */
type ResolvedOwner = {
  owner: string
  provider: PrReportRunProvider | null
  method: VcsAccessMethod | null
}

/**
 * The connected account, resolved from the deployment; asked for only when it cannot be.
 *
 * Null when the operator answered nothing and there was nothing stored to fall back on. `io.question`
 * ends with `defaultValue ?? ''`, so an unanswered prompt with no default is an EMPTY owner, and
 * writing that produces a `.env` whose every repository match is against `''`, whose creation link
 * carries `owner=`, and which `resolveConfig` then refuses as unset. That is a file this command
 * would have reported as written and done.
 */
async function resolveOwner(
  deps: ConfigureDeps,
  client: ConfigureClient,
  stored: string | undefined,
): Promise<ResolvedOwner | null> {
  const connection = await read(() => client.connection())
  if (connection.ok && connection.value) {
    deps.io.info(
      `Resolved repository owner '${connection.value.accountLogin}' from the workspace's ` +
        `${connection.value.provider} connection (${connection.value.method}).`,
    )
    return {
      owner: connection.value.accountLogin,
      provider: connection.value.provider,
      method: connection.value.method,
    }
  }
  deps.io.warn(
    connection.ok
      ? 'This workspace has no source-control connection, so the owner cannot be resolved and the ' +
          'suite will refuse until one is connected (SPA: Integrations). Answer with the account ' +
          'you will connect it to.'
      : `GET /api/v1/vcs/connection could not be read (${connection.error}), so this is NOT a ` +
          'verdict that nothing is connected. Answer with the account the two repositories live ' +
          'under.',
  )
  const answered = (await deps.io.question('Repository owner (user or org)', stored)).trim()
  return answered ? { owner: answered, provider: null, method: null } : null
}

/**
 * The two repository names, then {@link adoptRepo} for each: the names are the operator's choice, and
 * whether the connection can reach what they chose is not.
 */
async function resolveRepos(
  deps: ConfigureDeps,
  client: ConfigureClient,
  input: { owner: ResolvedOwner; prefix: string; previous: Record<string, string> },
): Promise<{ backend: string; frontend: string }> {
  const { io } = deps
  const backend = await io.question(
    'Backend repository name (you create it; empty, with a README)',
    input.previous.ACCEPTANCE_BACKEND_REPO ?? `${input.prefix}-catalog-api`,
  )
  const frontend = await io.question(
    'Frontend repository name',
    input.previous.ACCEPTANCE_FRONTEND_REPO ?? `${input.prefix}-catalog-web`,
  )
  for (const name of [backend, frontend]) {
    await adoptRepo(deps, client, { ...input.owner, name })
  }
  return { backend, frontend }
}

/**
 * Adopt one repository, retrying while the operator works on what only they can fix.
 *
 * The loop is the point, and it is now an ADOPT rather than a poll: `POST /api/v1/repos/link` is
 * idempotent, so the call that fixes "not linked yet" is the same call that answers "can this
 * connection reach it", and the pass's `target-repos` gate then finds the work already done. A
 * repository created under the wrong account, or outside a GitHub App's installation, is caught here
 * rather than at the start of an afternoon.
 *
 * **Every attempt STATES ITS OUTCOME, and a negative one carries the remedy.** A loop that reports
 * only its positive answer is indistinguishable from one doing nothing, and the operator concludes the
 * command is stuck rather than that the repository is still absent. The remedy is `adopt.ts`'s, the one
 * `target-repos` prints too, rendered through the gate's own {@link formatRemedy} so both surfaces read
 * alike.
 */
async function adoptRepo(
  deps: ConfigureDeps,
  client: ConfigureClient,
  target: ResolvedOwner & { name: string },
): Promise<void> {
  const { io } = deps
  const slug = `${target.owner}/${target.name}`
  let attempts = 0
  while (true) {
    const attempt = await read(() => client.link(target.owner, target.name))
    attempts += 1
    if (!attempt.ok) {
      // A failure that is not the documented 404 is a fact about the DEPLOYMENT, so it is reported as
      // one rather than turned into "go and create the repository": an unwired module (503) and a
      // provider outage (500) are both fixed somewhere else entirely, and the three-state rule this
      // command is built on applies hardest to the call that would otherwise blame the operator.
      io.warn(
        `POST /api/v1/repos/link could not be completed for ${slug} (${attempt.error}), so whether ` +
          'the repository exists is unknown rather than answered no.',
      )
      return
    }
    if (attempt.value.status === 'adopted') {
      // Reachable, and now linked by this command rather than by anybody's hand. Adoptable is the
      // stricter question and `serviceId` alone cannot answer it: a service homed on another board
      // answers `serviceId: null` WITH `linkedElsewhere: true`, so reporting only the id would call
      // this ready and leave the `repo_service_homed_elsewhere` 409 for the first adopt of an
      // hour-long pass.
      const repo = attempt.value.repo
      const blocker = repoBlocker(repo)
      if (blocker) io.warn(blockedRepoMessage(slug, blocker).join('\n'))
      else {
        io.info(
          `${slug} is adopted by this workspace` +
            (repo.serviceId ? `, and already backs service ${repo.serviceId}` : ''),
        )
      }
      return
    }

    // The answer to what the operator just did, on every attempt rather than only on the one that
    // succeeds: a silent negative reads as a no-op.
    io.warn(
      (attempts === 1
        ? `${slug} is not reachable by this workspace's connection.`
        : `Re-checked, and ${slug} is STILL not reachable.`) +
        ' Either it does not exist, or this credential is not granted it.',
    )
    // A search on the NAME alone, which is the only thing that separates a typo in the OWNER from a
    // credential that reaches nothing: the adopt has already answered the slug, and a slug search
    // cannot surface a look-alike (`intended/foo` does not match `someone-else/foo`). The steps read
    // it to name a same-named repository under another account. An unreadable answer contributes
    // nothing rather than an empty list, since "reaches nothing" is a claim this command would then be
    // making on a failed read's behalf.
    const nearby = await read(() => client.available(target.name))
    if (!nearby.ok) {
      io.warn(
        `GET /api/v1/repos/available could not be read (${nearby.error}), so what this connection ` +
          'CAN reach is unknown; the steps below stand on their own.',
      )
    }
    io.info(
      formatRemedy({
        steps: unreachableRepoSteps(nearby.ok ? nearby.value : [], [target], target.method),
      }),
    )

    const url = target.provider
      ? REPO_CREATION_URL[target.provider](target.owner, target.name)
      : null
    if (url) {
      // Printed before it is opened, always: the host is a github.com assumption this platform
      // cannot verify from `/api/v1` (an Enterprise Server deployment answers the same), so an
      // operator who is not on it can see that and go elsewhere.
      io.info(`Create it here (private, and tick "Add a README"):\n  ${url}`)
      // Offered as the DEFAULT only on the first attempt. Past one re-check the repository usually
      // exists and what is missing is the credential's access to it, so re-opening the creation form
      // is the one action that cannot help, and defaulting to it is how a loop starts feeling like a
      // dead end.
      if (await io.confirm('Open the creation page?', attempts === 1)) await io.openBrowser(url)
    } else {
      io.info(
        `Create '${target.name}' under '${target.owner}' on your provider: private, empty except ` +
          'for a README so it has a default branch for the scaffold pull request to target.',
      )
    }
    // Named for the call it makes, so the operator knows which read the answer above came from.
    if (!(await io.confirm(`Re-check ${slug} (retries POST /api/v1/repos/link)?`, true))) {
      io.warn(
        `Leaving '${target.name}' unconfirmed. The suite's 'target-repos' prerequisite will refuse ` +
          'until this connection can reach it, with the same steps as above.',
      )
      return
    }
  }
}

/**
 * The preset, offered as the library rather than asked for as an id.
 *
 * Availability is joined in from the model catalog and shown per row, which is the whole reason
 * this is a menu: `mdp_claude` and `mdp_kimi` are indistinguishable to type, and picking the one
 * whose provider nobody wired is a failure at the first dispatch.
 */
async function resolvePreset(
  deps: ConfigureDeps,
  client: ConfigureClient,
  stored: string | undefined,
): Promise<string> {
  const { io } = deps
  const [library, catalog] = await Promise.all([
    read(() => client.presets()),
    read(() => client.models()),
  ])
  const presets = library.ok ? library.value : []
  const first = presets[0]
  if (!first) {
    // Two causes, one fallback, and they are still worth telling apart: an unreadable library is a
    // deployment problem and an empty one is a workspace that holds no presets, which the gate will
    // then refuse for a different reason.
    io.warn(
      library.ok
        ? 'This workspace holds no model presets, so there is nothing to offer. Answer with an id ' +
            "and the 'model-preset' prerequisite will name what the deployment has."
        : `The preset library could not be read (${library.error}), so it is not offered as a menu.`,
    )
    return io.question('Model preset id', stored ?? 'mdp_claude')
  }
  // An unreadable catalog leaves every preset unmarked rather than marked unavailable: "we could not
  // check" and "no provider is wired" are opposite facts, and the second is the one that would stop
  // an operator picking a preset that works.
  if (!catalog.ok) {
    io.warn(
      `The model catalog could not be read (${catalog.error}), so the presets below are listed ` +
        'without saying which can be dispatched to.',
    )
  }
  // The same join `model-preset`'s remedy is built from (`presets.ts`), so this menu never offers
  // what that gate will refuse.
  const selectable = new Set(
    usablePresets(presets, catalog.ok ? catalog.value : []).map((preset) => preset.baseModelId),
  )
  const options = presets.map((preset) => ({
    value: preset.presetId,
    label:
      `${preset.name} (${preset.baseModelId})` +
      (catalog.ok && !selectable.has(preset.baseModelId) ? ' (no provider wired for it)' : '') +
      (preset.isDefault ? ' [workspace default]' : ''),
  }))
  // A selectable preset is preselected over the workspace default when the two differ, because the
  // default is whatever the board was seeded with and the pass has to actually be able to run.
  const fallback =
    presets.find((preset) => selectable.has(preset.baseModelId) && preset.isDefault) ??
    presets.find((preset) => selectable.has(preset.baseModelId)) ??
    first
  const stillOffered = stored && presets.some((preset) => preset.presetId === stored)
  return io.select(
    'Model preset every task this pass pins',
    options,
    stillOffered ? stored : fallback.presetId,
  )
}

/**
 * The cluster values, read from the kubeconfig the same way `cat-factory k3s` reads them.
 *
 * Two rules this path owes that the others do not:
 *
 *   - **The stored value still wins as the prompt default.** The kubeconfig's answer is the
 *     CURRENT kubectl context, which on a re-run to fix a repository name is quite possibly some
 *     other cluster; letting it displace what the file holds would silently re-point the pass, for
 *     the one pair of variables where being wrong costs the whole afternoon. It is reported when it
 *     DIFFERS, so an operator who did mean to move gets there with one keystroke.
 *   - **The URL and the token must come from the same cluster.** They are read from one context,
 *     and if the settled URL is not that context's, the token is not offered for it: a `.env`
 *     holding cluster A's URL with cluster B's bearer token fails with a 401 that reads exactly
 *     like the RBAC problem below.
 */
async function resolveCluster(
  deps: ConfigureDeps,
  previous: Record<string, string>,
): Promise<{ apiServerUrl: string; token: string }> {
  const { io, shell } = deps
  const server = await runCommand(shell, readApiServerCommand())
  // Normalised exactly as `cat-factory k3s` normalises it: k3d writes the wildcard bind address
  // `https://0.0.0.0:6443` into the kubeconfig, which is not dialable, and writing it unchanged
  // fails the `cluster-connection` prerequisite against an address nothing listens on.
  const resolvedServer =
    server.code === 0 ? normalizeApiServerUrl(stripTrailingSlash(server.stdout.trim())) : ''
  const stored = previous.ACCEPTANCE_K3S_API_SERVER
  if (resolvedServer) io.info(`The current kubeconfig context serves ${resolvedServer}.`)
  else {
    io.warn(
      'Could not read an apiserver URL from the current kubeconfig. `npx @cat-factory/cli k3s` ' +
        'provisions a local cluster, its ServiceAccount, the RBAC and a long-lived token.',
    )
  }
  if (stored && resolvedServer && stored !== resolvedServer) {
    io.warn(
      `The file already names ${stored}, which is NOT the current kubeconfig context ` +
        `(${resolvedServer}). Keeping the stored one, since a kubectl context is a passing state ` +
        `and this file is the pass's configuration. Answer with the other to move.`,
    )
  }
  const apiServerUrl = stripTrailingSlash(
    await io.question(
      'Cluster apiserver URL',
      stored || resolvedServer || 'https://127.0.0.1:6443',
    ),
  )

  // The token is only the kubeconfig's to give when the settled URL is the one that kubeconfig
  // serves. Anything else and it belongs to a different cluster.
  const tokenIsForThisCluster = resolvedServer !== '' && apiServerUrl === resolvedServer
  const secret = tokenIsForThisCluster ? await runCommand(shell, readTokenCommand()) : null
  const resolvedToken = secret && secret.code === 0 ? decodeToken(secret.stdout) : ''
  if (resolvedToken) {
    io.info('Read the cat-factory ServiceAccount token from the cluster (not shown).')
    return { apiServerUrl, token: resolvedToken }
  }
  if (!tokenIsForThisCluster && resolvedServer) {
    io.info(
      `Not reading a ServiceAccount token from the current kubeconfig: it serves ${resolvedServer}, ` +
        `and this pass targets ${apiServerUrl}. A token from the wrong cluster fails as a 401, ` +
        `which is indistinguishable from a permission problem.`,
    )
  }
  if (previous.ACCEPTANCE_K3S_TOKEN) {
    io.info('Keeping the ServiceAccount token already in the file (not shown).')
    return { apiServerUrl, token: previous.ACCEPTANCE_K3S_TOKEN }
  }
  io.warn(
    'No ServiceAccount token available for that cluster. A token minted against a cluster that ' +
      'has since been recreated is the usual cause, and it fails exactly like a permission ' +
      'problem. `npx @cat-factory/cli k3s` mints one against the current context.',
  )
  return { apiServerUrl, token: await io.secret('ServiceAccount bearer token') }
}

/** The managed block, in the order the README tables it. Comments are written for the reader. */
function buildEntries(input: {
  baseUrl: string
  apiKey: string
  workspaceId: string
  owner: string
  prefix: string
  repos: { backend: string; frontend: string }
  presetId: string
  cluster: { apiServerUrl: string; token: string }
}): readonly ManagedEntry[] {
  return [
    {
      comment: [
        'Acceptance suite (@cat-factory/acceptance), written by `run configure`.',
        'Gitignored: it holds an API token and a cluster credential.',
        'A variable exported in the shell WINS over this file, so a one-off',
        '`ACCEPTANCE_RUN_ID=latest pnpm … acceptance` resumes without editing anything.',
        'Backend origin serving /api/v1.',
      ],
      key: 'CAT_FACTORY_BASE_URL',
      value: input.baseUrl,
    },
    {
      comment: ['Public-API token, scope "Full access".'],
      key: 'CAT_FACTORY_API_KEY',
      value: input.apiKey,
    },
    {
      comment: ['Resolved from GET /api/v1/me; the token is bound to it.'],
      key: 'ACCEPTANCE_WORKSPACE_ID',
      value: input.workspaceId,
    },
    {
      comment: ['Resolved from GET /api/v1/vcs/connection.'],
      key: 'ACCEPTANCE_REPO_OWNER',
      value: input.owner,
    },
    {
      comment: [
        'The two repositories YOU created; the suite adopts them and scaffolds each',
        'through pl_build. Empty except for a README, so the scaffold pull request',
        'has a default branch to target.',
      ],
      key: 'ACCEPTANCE_BACKEND_REPO',
      value: input.repos.backend,
    },
    { key: 'ACCEPTANCE_FRONTEND_REPO', value: input.repos.frontend },
    {
      comment: ['Pinned on every task this pass files, so the pass is reproducible.'],
      key: 'ACCEPTANCE_MODEL_PRESET',
      value: input.presetId,
    },
    {
      comment: ['Prefix for the board frames and tasks; per-person when a board is shared.'],
      key: 'ACCEPTANCE_NAME_PREFIX',
      value: input.prefix,
    },
    {
      comment: ['The k3s cluster the deployer stands per-PR environments up on.'],
      key: 'ACCEPTANCE_K3S_API_SERVER',
      value: input.cluster.apiServerUrl,
    },
    { key: 'ACCEPTANCE_K3S_TOKEN', value: input.cluster.token },
    {
      comment: [
        'k3s self-signs its apiserver certificate. Paste ACCEPTANCE_K3S_CA_PEM instead',
        'to verify it; a supplied CA wins over this flag.',
      ],
      key: 'ACCEPTANCE_K3S_INSECURE',
      value: 'true',
    },
  ]
}

/**
 * The previous file's values, for use as prompt defaults.
 *
 * Blank is ABSENT, as it is everywhere else in this package: a `CAT_FACTORY_API_KEY=` line left in
 * a file states no token, and offering it as a default would have this command ask nothing and then
 * write the same empty value back.
 */
function readPrevious(text: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readAssignments(text)).filter(([, value]) => value.trim().length > 0),
  )
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The real deployment port, over the published SDK: the same client the suite itself drives. */
export function connectDeployment(baseUrl: string, apiKey: string): ConfigureClient {
  const client = new CatFactoryClient({ baseUrl, apiKey })
  return {
    async identity() {
      const identity = await client.me.get()
      return {
        workspaceId: identity.workspaceId,
        scope: identity.scope,
        label: identity.label,
      }
    },
    async connection() {
      const { connection } = await client.vcs.getConnection()
      return connection
        ? {
            accountLogin: connection.accountLogin,
            provider: connection.provider,
            method: connection.method,
          }
        : null
    },
    async link(owner, name) {
      try {
        const repo = await client.repos.link({ owner, name })
        return {
          status: 'adopted',
          repo: {
            owner: repo.owner,
            name: repo.name,
            serviceId: repo.serviceId,
            linkedElsewhere: repo.linkedElsewhere,
            monorepo: repo.monorepo,
          },
        }
      } catch (error) {
        // The ONE status this command turns into a value. `repo_not_reachable` is the documented
        // reason, and it is matched on the STATUS rather than the reason string because the status is
        // what the surface promises; anything else is a deployment fault and belongs to the caller's
        // three-state read.
        if (error instanceof CatFactoryNotFoundError) return { status: 'unreachable' }
        throw error
      }
    },
    async available(query) {
      const { repos } = await client.repos.listAvailable({ q: query })
      return repos.map((repo) => ({ owner: repo.owner, name: repo.name }))
    },
    async presets() {
      const { presets } = await client.modelPresets.list()
      return presets
    },
    async models() {
      const { models } = await client.models.list()
      return models
    },
  }
}
