// The job the Worker's ContainerAgentExecutor POSTs to /run. Kept as plain
// types with a hand-rolled validator so the image needs no schema dependency.
// `ghToken` and `sessionToken` are secrets: they are consumed (moved into env /
// git config) and never logged.

export interface RepoSpec {
  owner: string
  name: string
  baseBranch: string
  cloneUrl: string
}

export interface PrSpec {
  title: string
  body: string
}

export interface Job {
  /**
   * Stable identifier for this run's job, supplied by the Worker (the execution
   * id). The harness keys the background job on it so a re-dispatched `/run`
   * (a Workflows replay) re-attaches to the running job instead of starting a
   * duplicate, and the Worker polls `GET /jobs/{jobId}` with the same value.
   */
  jobId: string
  /** Composed role + best-practice fragments; written to AGENTS.md for Pi. */
  systemPrompt: string
  /** The concrete task prompt handed to Pi. */
  userPrompt: string
  /** Upstream model id Pi should request (the proxy locks it anyway). */
  model: string
  /** Worker LLM proxy base URL, including /v1. */
  proxyBaseUrl: string
  /** Signed, model-locked proxy session token (carries no provider key). */
  sessionToken: string
  /** Short-lived GitHub installation token for clone + PR. */
  ghToken: string
  repo: RepoSpec
  /** Branch Pi's work is pushed to. */
  headBranch: string
  pr: PrSpec
  /** GitHub REST base (override for GitHub Enterprise / tests). Defaults to api.github.com. */
  githubApiBase?: string
}

/** The /run response. `error` (when set) marks a job-level failure. */
export interface RunResult {
  prUrl?: string
  branch?: string
  summary?: string
  error?: string
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid job: '${path}' must be a non-empty string`)
  }
  return value
}

// ---- Bootstrap job (POST /bootstrap) --------------------------------------

/** The reference architecture clone source. */
export interface BootstrapReferenceSpec {
  owner: string
  name: string
  baseBranch: string
  cloneUrl: string
}

/** The new repository the bootstrapped contents are pushed to. */
export interface BootstrapTargetSpec {
  owner: string
  name: string
  cloneUrl: string
  defaultBranch: string
}

/** The job the Worker's ContainerRepoBootstrapper POSTs to /bootstrap. */
export interface BootstrapJob {
  /** Bootstrapper role prompt; written to AGENTS.md for Pi. */
  systemPrompt: string
  /** Free-form instructions handed to Pi as the task prompt. */
  instructions: string
  model: string
  proxyBaseUrl: string
  sessionToken: string
  ghToken: string
  reference: BootstrapReferenceSpec
  target: BootstrapTargetSpec
  githubApiBase?: string
}

/** The /bootstrap response. `error` (when set) marks a job-level failure. */
export interface BootstrapResult {
  defaultBranch?: string
  summary?: string
  error?: string
}

/** Validate + narrow an untrusted body into a {@link BootstrapJob}, throwing on bad input. */
export function parseBootstrapJob(input: unknown): BootstrapJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const reference = (o.reference ?? {}) as Record<string, unknown>
  const target = (o.target ?? {}) as Record<string, unknown>
  return {
    systemPrompt: str(o.systemPrompt, 'systemPrompt'),
    instructions: str(o.instructions, 'instructions'),
    model: str(o.model, 'model'),
    proxyBaseUrl: str(o.proxyBaseUrl, 'proxyBaseUrl'),
    sessionToken: str(o.sessionToken, 'sessionToken'),
    ghToken: str(o.ghToken, 'ghToken'),
    reference: {
      owner: str(reference.owner, 'reference.owner'),
      name: str(reference.name, 'reference.name'),
      baseBranch: str(reference.baseBranch, 'reference.baseBranch'),
      cloneUrl: str(reference.cloneUrl, 'reference.cloneUrl'),
    },
    target: {
      owner: str(target.owner, 'target.owner'),
      name: str(target.name, 'target.name'),
      cloneUrl: str(target.cloneUrl, 'target.cloneUrl'),
      defaultBranch: str(target.defaultBranch, 'target.defaultBranch'),
    },
    ...(typeof o.githubApiBase === 'string' ? { githubApiBase: o.githubApiBase } : {}),
  }
}

/** Validate + narrow an untrusted body into a {@link Job}, throwing on bad input. */
export function parseJob(input: unknown): Job {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const repo = (o.repo ?? {}) as Record<string, unknown>
  const pr = (o.pr ?? {}) as Record<string, unknown>
  return {
    jobId: str(o.jobId, 'jobId'),
    systemPrompt: str(o.systemPrompt, 'systemPrompt'),
    userPrompt: str(o.userPrompt, 'userPrompt'),
    model: str(o.model, 'model'),
    proxyBaseUrl: str(o.proxyBaseUrl, 'proxyBaseUrl'),
    sessionToken: str(o.sessionToken, 'sessionToken'),
    ghToken: str(o.ghToken, 'ghToken'),
    repo: {
      owner: str(repo.owner, 'repo.owner'),
      name: str(repo.name, 'repo.name'),
      baseBranch: str(repo.baseBranch, 'repo.baseBranch'),
      cloneUrl: str(repo.cloneUrl, 'repo.cloneUrl'),
    },
    headBranch: str(o.headBranch, 'headBranch'),
    pr: {
      title: str(pr.title, 'pr.title'),
      body: typeof pr.body === 'string' ? pr.body : '',
    },
    ...(typeof o.githubApiBase === 'string' ? { githubApiBase: o.githubApiBase } : {}),
  }
}
