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

/** Validate + narrow an untrusted body into a {@link Job}, throwing on bad input. */
export function parseJob(input: unknown): Job {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const repo = (o.repo ?? {}) as Record<string, unknown>
  const pr = (o.pr ?? {}) as Record<string, unknown>
  return {
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
