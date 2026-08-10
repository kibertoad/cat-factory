// What the suite needs from the environment, resolved ONCE and reported as a whole.
//
// The resolution is a pure function over a plain record so it can be unit-tested with no
// environment at all (`test/config.test.ts`), and so the refusal can be asserted rather than
// discovered by running the suite against a half-configured box.
//
// **Every missing variable is reported together.** A suite that refuses on the first absent
// name sends someone round the loop once per variable, and this one needs eight; the failure a
// person actually wants is the whole list plus what each is for.

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
}

/**
 * The two repositories a pass runs against, BY NAME.
 *
 * Named rather than derived, because the operator creates them: repository creation is the one
 * setup step this suite cannot perform (a PAT connection reports `canCreateRepos: false`, and the
 * App path creates only under `/orgs/{org}/repos`), so the names are an input rather than a
 * `${prefix}-catalog-api-${runId}` the suite mints for itself. See
 * `docs/initiatives/acceptance-suite-operator-setup.md`.
 */
export type RepoNames = {
  backend: string
  frontend: string
}

export type AcceptanceConfig = {
  /** Backend origin serving `/api/v1`, plus the two unauthenticated deployment root reads. */
  baseUrl: string
  /** A public-API key at `admin` (spec 03 answers a human gate, so it must also carry `decide`). */
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
  /** Where the resumable ledger lives. Relative paths resolve against the package directory. */
  stateDir: string
  /**
   * Ceiling for ONE pipeline run, in ms. Not a vitest timeout: it is the deadline the run-waiter
   * grades against, so exceeding it reports which step was still working (see `deadline.ts`).
   */
  runBudgetMs: number
}

type EnvRecord = Readonly<Record<string, string | undefined>>

/** One required variable: the name, what it is for, and how to read it out of the record. */
type Requirement = {
  name: string
  purpose: string
}

const REQUIRED: readonly Requirement[] = [
  { name: 'CAT_FACTORY_BASE_URL', purpose: 'backend origin, e.g. http://127.0.0.1:8787' },
  {
    name: 'CAT_FACTORY_API_KEY',
    purpose: "public-API key (cf_live_…) scoped 'admin'; spec 03 also needs 'decide'",
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
  { name: 'ACCEPTANCE_K3S_API_SERVER', purpose: 'kube-apiserver URL, e.g. https://127.0.0.1:6443' },
  {
    name: 'ACCEPTANCE_K3S_TOKEN',
    purpose: 'ServiceAccount bearer token with the RBAC in backend/docs/local-k3s-environments.md',
  },
]

export type ConfigResolution =
  | { ok: true; config: AcceptanceConfig }
  | { ok: false; problems: readonly string[] }

/**
 * Resolve the suite's configuration, collecting EVERY problem rather than throwing on the first.
 *
 * Pure over `env` so the refusal is testable. `requireConfig` is the thin caller that turns a
 * refusal into the error the specs see.
 */
export function resolveConfig(env: EnvRecord): ConfigResolution {
  const problems: string[] = []
  for (const { name, purpose } of REQUIRED) {
    if (!trimmed(env[name])) problems.push(`${name} is required (${purpose})`)
  }

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
          trimmed(env.ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE) ?? '{{namespace}}.127.0.0.1.nip.io',
        namespaceTemplate:
          trimmed(env.ACCEPTANCE_K3S_NAMESPACE_TEMPLATE) ?? 'cf-acc-{{pullNumber}}',
      },
      stateDir: trimmed(env.ACCEPTANCE_STATE_DIR) ?? '.acceptance',
      // 90 minutes. A `pl_build` run with a design pass, a container coder, two testers and a
      // real CI gate routinely takes 30–45; the budget is generous because the thing it is
      // guarding against is a run that has STOPPED, not one that is slow.
      runBudgetMs: runBudget ?? 90 * 60 * 1000,
    },
  }
}

/** Resolve or throw, with every problem in one message. */
export function requireConfig(env: EnvRecord = process.env): AcceptanceConfig {
  const resolution = resolveConfig(env)
  if (resolution.ok) return resolution.config
  throw new Error(
    `The acceptance suite is not configured. It runs against a LIVE deployment and creates real ` +
      `repositories, so it refuses to guess.\n\n` +
      resolution.problems.map((problem) => `  - ${problem}`).join('\n') +
      `\n\nSee backend/internal/acceptance/README.md for a worked local setup.`,
  )
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
