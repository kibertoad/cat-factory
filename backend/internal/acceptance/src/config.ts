import { OperatorRefusal, resolveStateDir } from '@cat-factory/acceptance-kit'
import { packageRoot } from './packageRoot.ts'
// What the suite needs from the environment, resolved ONCE and reported as a whole.
//
// The resolution is a pure function over a plain record so it can be unit-tested with no
// environment at all (`test/config.test.ts`), and so the refusal can be asserted rather than
// discovered by running the suite against a half-configured box.
//
// **Every missing variable is reported together.** A suite that refuses on the first absent
// name sends someone round the loop once per variable, and this one needs nine; the failure a
// person actually wants is the whole list plus what each is for.
//
// **It resolves in two halves, and which half a command needs is a fact about the command.** A
// BOARD (the deployment, the key, the two repositories, the state directory) is what an `/api/v1`
// caller needs; a PASS needs that plus a cluster to deploy onto, a reporter credential and a
// per-run budget. `reset` is why the seam exists rather than being tidy: an operator clearing a
// half-built pass off a board is often doing it because the cluster it named is gone, and a cleanup
// that refuses until the abandoned thing is configured again is a cleanup nobody can run.

/**
 * The two templates a pass falls back to, exported because the CHECKS offer them as the fix.
 *
 * Both `manifestTemplates.ts` remedies end on "unsetting the variable is also a fix, since the
 * default below is what it falls back to", and that sentence is only true while the value it
 * prints is the value {@link resolveConfig} actually falls back to. As two literals in two files
 * it was true by coincidence: changing the fallback would have handed the operator a pasteable
 * command setting something else, with nothing failing.
 */
export const DEFAULT_INGRESS_HOST_TEMPLATE = '{{namespace}}.127.0.0.1.nip.io'

export const DEFAULT_IMAGE_TEMPLATE = 'ghcr.io/{{repoOwner}}/{{repoName}}:pr-{{pullNumber}}'

/**
 * The doc that owns the cluster half of this setup, for the same reason the two defaults above are
 * here: four places cite it and one of them is a REMEDY an operator is told to open.
 *
 * `prerequisites.ts` and `manifestTemplates.ts` end their k3s refusals on it, `k3s.ts` cites it for
 * the kustomize path it does not cover, and the `ACCEPTANCE_K3S_TOKEN` requirement below points at
 * the RBAC it documents. Nothing joins a path in a string to a file on disk, and no guard here
 * covers this one, so a rename is caught by nothing: what keeps the four honest is that there is
 * one of them.
 */
export const K3S_DOC = 'backend/docs/local-k3s-environments.md'

/** A k3s/Kubernetes apiserver the `deployer` step provisions per-PR namespaces against. */
export type ClusterConfig = {
  apiServerUrl: string
  /** The ServiceAccount bearer token (`kubernetes.io/service-account-token`). */
  apiToken: string
  /** The cluster CA in PEM, or null when `insecureSkipTlsVerify` carries the connection. */
  caCertPem: string | null
  insecureSkipTlsVerify: boolean
  /**
   * Host template the environment URL is derived from. The default works on any k3d/k3s with
   * Traefik: `nip.io` resolves `<anything>.127.0.0.1` to loopback, so no DNS or hosts-file edit
   * stands between the run and a reachable environment.
   */
  ingressHostTemplate: string
  namespaceTemplate: string
  /**
   * What the manifests' `{{image}}` placeholder resolves to, per pull request.
   *
   * Configured rather than defaulted-away, and REQUIRED in effect: the scaffold briefs make
   * `{{image}}` mandatory in every Deployment, and the platform renders a hole it cannot fill as
   * the empty string, so a connection carrying no template applies `image: ""` and the apiserver
   * refuses the Deployment. The default publishes under the pull request's own number because
   * that is the one per-PR discriminator the provision knows AND a legal image tag: a provision
   * carries no commit sha, and `{{branch}}` is `cat-factory/<taskId>`, which no tag may contain.
   */
  imageTemplate: string
}

/**
 * The two repositories a pass runs against, BY NAME.
 *
 * Named rather than derived, because the operator creates them: repository creation is the one
 * setup step this suite cannot perform (a PAT connection reports `canCreateRepos: false`, and the
 * App path creates only under `/orgs/{org}/repos`), so the names are an input rather than a
 * `${prefix}-catalog-api-${runId}` the suite mints for itself. See
 * `backend/docs/adr/0056-acceptance-suite-operator-setup.md`.
 */
export type RepoNames = {
  backend: string
  frontend: string
}

/**
 * The credential the suite files scenario 04's issue with, as an OUTSIDE reporter.
 *
 * Deliberately NOT the workspace's own VCS connection: the platform's credential closing an issue
 * the platform's credential filed proves only that the credential works. Scenario 04's premise is that
 * somebody with no relationship to this deployment opens an issue, so the reporter holds a token of
 * its own, and there is no `/api/v1` operation for either half (nor should there be: filing an issue
 * is not something this product does for you). See `vcsIssues.ts`.
 */
export type VcsReporterConfig = {
  /** A provider token that may read the target repository and open an issue on it. */
  token: string
  /**
   * The provider's REST base. Defaults to GitHub's; an Enterprise Server host is
   * `https://<host>/api/v3`, which nothing in `/api/v1` publishes, so it is configured rather
   * than derived.
   */
  apiBaseUrl: string
}

/**
 * The half of the configuration that names a BOARD: the deployment, the key, the two repositories
 * and where a pass's files live. See the header for why the split exists.
 *
 * The line it draws is what a command TOUCHES, not how important a variable feels: everything here
 * is read by an `/api/v1` call against one board, and everything {@link AcceptanceConfig} adds
 * belongs to RUNNING a pass.
 */
export type BoardConfig = {
  /** Backend origin serving `/api/v1`, plus the two unauthenticated deployment root reads. */
  baseUrl: string
  /** A public-API key at `admin` (scenario 03 answers a human gate, so it must also carry `decide`). */
  apiKey: string
  /**
   * The workspace the key is bound to.
   *
   * Every `/api/v1` call is implicitly scoped to it, so nothing sends it on the wire. It is
   * configured anyway because `assertWorkspaceMatchesKey` checks it against what `GET /api/v1/me`
   * reports before anything is created: a key pasted from another workspace otherwise bootstraps
   * two repositories onto a board nobody was watching, and every later assertion still passes.
   */
  workspaceId: string
  /** GitHub owner (user or org) the two adopted repositories live under. */
  repoOwner: string
  /**
   * Prefix for every service frame and task the suite creates. Defaults to `cf-acc`; set it
   * per-operator when several people share one board, since `board-titles` refuses a fresh pass
   * whose frame titles a previous one already took.
   *
   * It no longer names the REPOSITORIES: those are `repos`, chosen by whoever created them.
   */
  namePrefix: string
  repos: RepoNames
  /** Where the resumable ledger lives. Relative paths resolve against the package directory. */
  stateDir: string
}

export type AcceptanceConfig = BoardConfig & {
  /**
   * The model preset every task this pass files pins (`ACCEPTANCE_MODEL_PRESET`, default
   * `mdp_claude`).
   *
   * The preset ID `/api/v1` reports, never a friendlier `claude` alias: resolving a second naming
   * scheme would mean guessing (an `mdp_` prefix? the display name?) against a library a deployment
   * can fill with anything, and `configure` removes the reason to want one by offering the library
   * as a menu.
   *
   * Pinned rather than left to resolve, so a pass runs on the model it says it ran on: the
   * workspace default is whatever someone last chose on that board, and a pass that silently
   * adopted it would report a result nobody can reproduce.
   */
  modelPresetId: string
  cluster: ClusterConfig
  vcs: VcsReporterConfig
  /**
   * Ceiling for ONE pipeline run, in ms. Not a whole-scenario timeout: it is the deadline the run-waiter
   * grades against, so exceeding it reports which step was still working (see the kit's `deadline.ts`).
   */
  runBudgetMs: number
}

type EnvRecord = Readonly<Record<string, string | undefined>>

/** One required variable: the name, what it is for, and how to read it out of the record. */
type Requirement = {
  name: string
  purpose: string
}

/**
 * What it takes to name a BOARD: the deployment, the key and the two repositories.
 *
 * Its own table because {@link resolveBoardConfig} is what a command that only reads and writes
 * `/api/v1` needs, and because the two lists then cannot fall out of step with the types they fill:
 * a variable belongs to whichever half of the config carries it.
 */
const BOARD_REQUIRED: readonly Requirement[] = [
  { name: 'CAT_FACTORY_BASE_URL', purpose: 'backend origin, e.g. http://127.0.0.1:8787' },
  {
    name: 'CAT_FACTORY_API_KEY',
    purpose: "public-API key (cf_live_…) scoped 'admin'; scenario 03 also needs 'decide'",
  },
  {
    name: 'ACCEPTANCE_WORKSPACE_ID',
    purpose: 'workspace the key is bound to (GET /api/v1/me reports it)',
  },
  {
    name: 'ACCEPTANCE_REPO_OWNER',
    purpose: 'GitHub owner the two repositories live under (GET /api/v1/vcs/connection reports it)',
  },
  {
    name: 'ACCEPTANCE_BACKEND_REPO',
    purpose: 'name of the empty repository the backend service adopts; you create it',
  },
  {
    name: 'ACCEPTANCE_FRONTEND_REPO',
    purpose: 'name of the empty repository the frontend service adopts; you create it',
  },
]

/**
 * What it takes to act as the outside REPORTER, which is also what `reset --purge-repos` needs.
 *
 * Its own slice of the table rather than a second spelling of the entry, because two commands need
 * exactly this credential and one of them ({@link resolveReporterConfig}) needs nothing else: an
 * operator emptying two fixture repositories should not be refused over the k3s token they
 * abandoned. Sliced, so the variable is still named, and its permissions still described, once.
 */
const REPORTER_REQUIRED: readonly Requirement[] = [
  {
    name: 'ACCEPTANCE_VCS_TOKEN',
    purpose:
      "provider token the suite files scenario 04's issue with, as an outside reporter would, and " +
      'that `reset --purge-repos` empties the two repositories with (GitHub classic: `repo` plus ' +
      '`workflow`; fine-grained: Contents, Issues and Workflows read+write on both repositories). ' +
      'The workflow permission is not optional for the purge: a scaffolded repository holds a ' +
      'GitHub Actions workflow, and a commit that removes one is refused without it',
  },
]

/** What it takes to RUN a pass on that board: something to deploy onto, and someone to report as. */
const RUN_REQUIRED: readonly Requirement[] = [
  ...REPORTER_REQUIRED,
  { name: 'ACCEPTANCE_K3S_API_SERVER', purpose: 'kube-apiserver URL, e.g. https://127.0.0.1:6443' },
  {
    name: 'ACCEPTANCE_K3S_TOKEN',
    purpose: `ServiceAccount bearer token with the RBAC in ${K3S_DOC}`,
  },
]

export type ConfigResolution =
  | { ok: true; config: AcceptanceConfig }
  | { ok: false; problems: readonly string[] }

export type BoardConfigResolution =
  | { ok: true; config: BoardConfig }
  | { ok: false; problems: readonly string[] }

/**
 * Resolve just the BOARD half, for a command that reads and writes `/api/v1` and nothing else.
 *
 * Every problem at once, exactly as {@link resolveConfig} reports its own: this is the same rule
 * applied to a smaller list, not a laxer version of it.
 *
 * The repository-name collision is checked HERE rather than beside the cluster rules, because it is
 * a fact about the two repositories a board is pointed at: `reset` resolves which frames those
 * repositories back, so one name for both would have it plan a single frame while the operator
 * believes two are being cleared.
 */
export function resolveBoardConfig(env: EnvRecord): BoardConfigResolution {
  const problems = missing(env, BOARD_REQUIRED)

  // Two services, two repositories: the planted defect lives BETWEEN them (`instructions.ts`), and
  // one name for both would back the frontend frame with the repository the backend frame already
  // holds, so every "cross-service" assertion afterwards would be about a single service.
  const backendRepo = trimmed(env.ACCEPTANCE_BACKEND_REPO)
  const frontendRepo = trimmed(env.ACCEPTANCE_FRONTEND_REPO)
  if (backendRepo && frontendRepo && backendRepo.toLowerCase() === frontendRepo.toLowerCase()) {
    problems.push(
      `ACCEPTANCE_BACKEND_REPO and ACCEPTANCE_FRONTEND_REPO both name '${backendRepo}'. This ` +
        `suite needs two repositories, because the defect it hunts exists only between them.`,
    )
  }

  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    config: {
      baseUrl: stripTrailingSlash(required(env, 'CAT_FACTORY_BASE_URL')),
      apiKey: required(env, 'CAT_FACTORY_API_KEY'),
      workspaceId: required(env, 'ACCEPTANCE_WORKSPACE_ID'),
      repoOwner: required(env, 'ACCEPTANCE_REPO_OWNER'),
      namePrefix: trimmed(env.ACCEPTANCE_NAME_PREFIX) ?? 'cf-acc',
      repos: {
        backend: required(env, 'ACCEPTANCE_BACKEND_REPO'),
        frontend: required(env, 'ACCEPTANCE_FRONTEND_REPO'),
      },
      stateDir: stateDirFrom(env),
    },
  }
}

/**
 * Resolve the suite's configuration, collecting EVERY problem rather than throwing on the first.
 *
 * Pure over `env` so the refusal is testable. `requireConfig` is the thin caller that turns a
 * refusal into the error the scenarios see.
 *
 * Built ON the board half rather than beside it, so a variable is named in exactly one table and a
 * pass and a cleanup cannot come to disagree about which board they are pointed at. The board
 * problems are collected even when the board half is unresolvable, because reporting one half at a
 * time is the loop this whole function exists to avoid.
 */
export function resolveConfig(env: EnvRecord): ConfigResolution {
  const board = resolveBoardConfig(env)
  const reporter = resolveReporterConfig(env)
  const problems = [...(board.ok ? [] : board.problems), ...missing(env, RUN_REQUIRED)]

  const insecure = readBoolean(env.ACCEPTANCE_K3S_INSECURE)
  const caCertPem = trimmed(env.ACCEPTANCE_K3S_CA_PEM)
  // A cluster reached over HTTPS needs one or the other, and k3s self-signs, so a config with
  // neither is the common first-run mistake. Saying so here beats a TLS error from deep inside
  // the deployer's apiserver client, which surfaces on the RUN rather than on the setup.
  if (!caCertPem && !insecure) {
    problems.push(
      'ACCEPTANCE_K3S_CA_PEM or ACCEPTANCE_K3S_INSECURE=true is required (k3s self-signs its ' +
        'apiserver certificate, so neither leaves the deployer unable to verify the connection)',
    )
  }

  // Blank is ABSENT here as it is for every other variable: an `ACCEPTANCE_RUN_BUDGET_MS=` line
  // left in a `.env` states no budget, and refusing it as a malformed integer would send an
  // operator hunting for a value they deliberately did not set.
  const budgetText = trimmed(env.ACCEPTANCE_RUN_BUDGET_MS)
  const runBudget = budgetText === null ? null : readPositiveInt(budgetText)
  if (budgetText !== null && runBudget === null) {
    problems.push(
      `ACCEPTANCE_RUN_BUDGET_MS ('${budgetText}') must be a positive integer of milliseconds`,
    )
  }

  // `board.ok` and `reporter.ok` are re-tested rather than inferred from an empty `problems`: they
  // are what NARROW the two halves below, and a refusal that already collected its problems cannot
  // also hand one over.
  if (!board.ok || !reporter.ok || problems.length > 0) return { ok: false, problems }

  return {
    ok: true,
    config: {
      ...board.config,
      // The built-in Claude preset, which every deployment seeds, so an operator who configured
      // nothing still names a preset that exists. It is the id `/api/v1` reports rather than a
      // friendlier `claude` alias: a second naming scheme for one preset would have to be resolved
      // by guessing (`mdp_` prefix? the display name?), and `configure` removes the reason to want
      // one by offering the library as a menu.
      modelPresetId: trimmed(env.ACCEPTANCE_MODEL_PRESET) ?? 'mdp_claude',
      cluster: {
        apiServerUrl: stripTrailingSlash(required(env, 'ACCEPTANCE_K3S_API_SERVER')),
        apiToken: required(env, 'ACCEPTANCE_K3S_TOKEN'),
        caCertPem,
        insecureSkipTlsVerify: insecure,
        ingressHostTemplate:
          trimmed(env.ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE) ?? DEFAULT_INGRESS_HOST_TEMPLATE,
        namespaceTemplate:
          trimmed(env.ACCEPTANCE_K3S_NAMESPACE_TEMPLATE) ?? 'cf-acc-{{pullNumber}}',
        // GHCR under the repository's own owner, which needs no second credential decision on
        // either side: the workflow the briefs ask for pushes there with the `GITHUB_TOKEN` it
        // already has, and the platform wires the workspace's own VCS credential into each per-PR
        // namespace so the cluster can pull it back. The `image-template` prerequisite renders
        // this before a pass starts and says what it could not check.
        imageTemplate: trimmed(env.ACCEPTANCE_K3S_IMAGE_TEMPLATE) ?? DEFAULT_IMAGE_TEMPLATE,
      },
      // The reporter half, resolved by the function `reset --purge-repos` calls rather than beside
      // it: a second spelling of the default REST base is a second thing to change on the day an
      // Enterprise Server deployment needs one, and the two would then disagree per command.
      vcs: reporter.reporter,
      // 90 minutes. A `pl_build` run with a design pass, a container coder, two testers and a
      // real CI gate routinely takes 30–45; the budget is generous because the thing it is
      // guarding against is a run that has STOPPED, not one that is slow.
      runBudgetMs: runBudget ?? 90 * 60 * 1000,
    },
  }
}

export type ReporterConfigResolution =
  | { ok: true; reporter: VcsReporterConfig }
  | { ok: false; problems: readonly string[] }

/**
 * Resolve JUST the reporter credential, for `reset --purge-repos`.
 *
 * Its own resolver rather than a reach into {@link resolveConfig}, because the whole point of the
 * board/pass split is that a cleanup does not need a cluster: an operator emptying two fixture
 * repositories should not be refused because the k3s token they abandoned is missing. This is the
 * third shape that split implies (board, board + reporter, board + reporter + cluster) and it is
 * built from the same table, so a variable is still named in exactly one place.
 */
export function resolveReporterConfig(env: EnvRecord): ReporterConfigResolution {
  const problems = missing(env, REPORTER_REQUIRED)
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    reporter: {
      token: required(env, 'ACCEPTANCE_VCS_TOKEN'),
      // GitHub's public REST base, which is right for every github.com deployment and wrong in
      // exactly one knowable way (Enterprise Server), so it is overridable rather than assumed.
      apiBaseUrl: stripTrailingSlash(
        trimmed(env.ACCEPTANCE_VCS_API_BASE) ?? 'https://api.github.com',
      ),
    },
  }
}

/**
 * Where a pass keeps its ledger and journal, ABSOLUTE, from the environment alone.
 *
 * Separate from `resolveConfig` because two callers need it WITHOUT the rest: the status CLI, which
 * takes no API key and no cluster, and `runAcceptance.ts`, which resolves the pass's run id before
 * the preflight exists to report a half-configured deployment. Both had the default spelled out again;
 * a third spelling of `.acceptance` is a state directory an operator cannot find.
 *
 * Resolved HERE and nowhere else, which is the seam the kit asks for: a relative path is anchored on
 * this package (where the operator's `.env` lives) rather than on the kit's own install path, and
 * every reader below it then takes an absolute directory rather than re-deciding what a relative one
 * means. Two CLIs used to re-resolve it, which is one place too many for a value that names where a
 * pass can be found.
 */
export function stateDirFrom(env: EnvRecord): string {
  return resolveStateDir(trimmed(env.ACCEPTANCE_STATE_DIR) ?? '.acceptance', packageRoot)
}

/**
 * Resolve or refuse, with every problem in one message.
 *
 * An {@link OperatorRefusal} rather than a bare `Error`, because the boundary that catches this also
 * catches whatever the resolution itself can throw, and the two are printed differently: this list is
 * the whole message and a stack above it is noise, while a bug in the resolution is unreadable without
 * one.
 */
export function requireConfig(env: EnvRecord = process.env): AcceptanceConfig {
  const resolution = resolveConfig(env)
  if (resolution.ok) return resolution.config
  throw new OperatorRefusal(unconfigured(resolution.problems))
}

function unconfigured(problems: readonly string[]): string {
  return (
    `The acceptance suite is not configured. It runs against a LIVE deployment and creates real ` +
    `repositories, so it refuses to guess.\n\n` +
    problems.map((problem) => `  - ${problem}`).join('\n') +
    `\n\nSee backend/internal/acceptance/README.md for a worked local setup.`
  )
}

/** The names in a table the environment does not carry, each with what it is for. */
function missing(env: EnvRecord, table: readonly Requirement[]): string[] {
  return table
    .filter(({ name }) => !trimmed(env[name]))
    .map(({ name, purpose }) => `${name} is required (${purpose})`)
}

function required(env: EnvRecord, name: string): string {
  const value = trimmed(env[name])
  /* c8 ignore next 2 -- unreachable: `resolveConfig` returns the refusal before it reads a value */
  if (value === null) throw new Error(`${name} is required`)
  return value
}

function trimmed(value: string | undefined): string | null {
  const next = value?.trim()
  return next ? next : null
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function readBoolean(value: string | undefined): boolean {
  return trimmed(value)?.toLowerCase() === 'true'
}

/** Takes an already-trimmed, non-empty value, so its `null` means MALFORMED and never absent. */
function readPositiveInt(raw: string): number | null {
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
