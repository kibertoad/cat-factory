import { randomUUID } from 'node:crypto'
import type {
  Clock,
  GitHubClient,
  GitHubRepo,
  GroupCacheHandle,
  IdGenerator,
  InstallationPermissions,
  Paged,
  RateLimitRepository,
  RateLimitSnapshot,
} from '@cat-factory/kernel'
import type { Logger, VcsIdentityRegistry, VcsProvider } from '@cat-factory/kernel'
import { runBestEffort } from '@cat-factory/kernel'
import type { LocalVcsCredential } from './vcsCredential.js'
import {
  type AppTokenSource,
  FetchGitHubClient,
  GitHubIdentityResolver,
  logger,
} from '@cat-factory/server'
import {
  buildGitLabEngineClient,
  GITLAB_PUBLIC_API_BASE,
  GitLabIdentityResolver,
} from '@cat-factory/gitlab'
import type { PatAccount } from './installations.js'

// PAT-backed GitHub access for local mode. The shared FetchGitHubClient normally mints
// per-installation tokens via the GitHub App registry; here we feed it a token source returning
// the deployment's PAT, so the CI gate + merge / mergeability providers (wired in container.ts
// from this client) hit real GitHub with the PAT.
//
// Every token read here goes through a getter rather than a captured string: local mode's
// credential can be installed from the sign-in screen while the server runs (see
// `vcsCredential.ts`), and a value snapshotted at container-build time would pin the state the
// process booted in.
//
// The app-JWT paths (installation discovery / listing) are never reached in local
// mode — those are the GitHub-App connect flow, which local mode replaces with the
// linkRepo helper — so they throw rather than pretend to work.

// The scopes a local-mode PAT needs. Agent containers clone/push branches and open PRs
// (`repo`, which also covers reading the PR head's Actions check runs for the CI gate and
// merging the PR), and the coder/ci-fixer may touch `.github/workflows/*` files (`workflow`).
const LOCAL_PAT_SCOPES = ['repo', 'workflow'] as const

/**
 * A GitHub "new personal access token (classic)" URL with the scopes local mode needs
 * pre-selected, so a developer without a PAT can click straight through to create one.
 * Classic tokens are used (not fine-grained) because only the classic form accepts the
 * `scopes` query param for pre-selection.
 */
export function githubPatCreationUrl(): string {
  const params = new URLSearchParams({
    description: 'cat-factory local mode',
    scopes: LOCAL_PAT_SCOPES.join(','),
  })
  return `https://github.com/settings/tokens/new?${params.toString()}`
}

/**
 * The refusal every credential-reading path shares, so an unconfigured deployment says the same
 * actionable thing wherever it is hit (a gate probe, a repo enumeration, a clone) instead of a
 * generic 500 or an empty result that reads like "no repos".
 */
export function noVcsCredentialError(): Error {
  return new Error(
    'This deployment has no source-control token yet. Sign in with a GitHub or GitLab personal access token, or set GITHUB_PAT / GITLAB_PAT in your .env.',
  )
}

/**
 * An {@link AppTokenSource} that returns the deployment's CURRENT PAT for every installation call.
 * The token is read per call, so a credential installed from the sign-in screen is used by the
 * very next dispatch.
 */
export class LocalPatAppTokenSource implements AppTokenSource {
  readonly defaultAppId = ''
  constructor(private readonly resolveToken: () => string | undefined) {}

  apps(): readonly { appId: string }[] {
    return [{ appId: '' }]
  }

  authForApp(): { appJwt(): Promise<string> } {
    return {
      appJwt: () =>
        Promise.reject(new Error('GitHub App JWT is not available in local (PAT) mode')),
    }
  }

  installationToken(): Promise<string> {
    const token = this.resolveToken()
    return token ? Promise.resolve(token) : Promise.reject(noVcsCredentialError())
  }

  // A static PAT carries no App-granted permissions map; canPush then relies on the
  // repo object's user-role `permissions.push`, which IS authoritative for a PAT.
  installationPermissions(): Promise<InstallationPermissions> {
    return Promise.resolve({})
  }
}

/** Rate-limit accounting is best-effort telemetry the local facade simply drops. */
class NoopRateLimitRepository implements RateLimitRepository {
  record(_snapshot: RateLimitSnapshot): Promise<void> {
    return Promise.resolve()
  }
  deleteOlderThan(_epochMs: number): Promise<number> {
    return Promise.resolve(0)
  }
}

const localIdGenerator: IdGenerator = {
  next: (prefix?: string) => (prefix ? `${prefix}_${randomUUID()}` : randomUUID()),
}

const localClock: Clock = { now: () => Date.now() }

function patHeaders(pat: string): Record<string, string> {
  return {
    authorization: `Bearer ${pat}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'cat-factory',
  }
}

/**
 * A {@link FetchGitHubClient} that lists repos a PAT can access via `/user/repos`, the
 * personal-token analogue of the App-only `/installation/repositories` the base client
 * uses (which 403s for a PAT). The board's "Add from existing repo" picker, the
 * link-a-repo flow and the monorepo browser all enumerate repos through
 * `listInstallationRepos`, so overriding this one method makes them work under a PAT.
 * Every other call (repo/branch/PR/issue reads, merges) already works with the PAT via
 * the installation-token paths, so they fall through to the base implementation.
 */
class PatGitHubClient extends FetchGitHubClient {
  constructor(
    deps: ConstructorParameters<typeof FetchGitHubClient>[0],
    private readonly resolvePat: () => string | undefined,
    /**
     * The `AppCaches.patInstallationRepos` handle (keyed/grouped by installation id). When
     * wired, the realtime picker search filters a cached complete enumeration in memory
     * instead of re-walking `/user/repos` on every keystroke. Absent (mothership boot /
     * tests) ⇒ the search enumerates live per request, as before.
     */
    private readonly repoEnumCache?: GroupCacheHandle<GitHubRepo[]>,
  ) {
    super(deps)
  }

  override async listInstallationRepos(installationId: number): Promise<Paged<GitHubRepo>> {
    // Delegate to the base client's `/user/repos` walk rather than keeping a duplicate one:
    // it reads page 1, learns the page count from the `Link: rel="last"` header, and fetches
    // the remaining pages CONCURRENTLY — a broad PAT costs ~2 round-trips instead of a serial
    // page-by-page crawl. The rows come back stamped as personal (`user_pat`, placeholder
    // installation), so re-stamp them: local mode's shared `GITHUB_PAT` is the workspace-wide
    // credential, so repos it enumerates are App-reachable (visible to every member).
    const pat = this.resolvePat()
    if (!pat) throw noVcsCredentialError()
    const { items, truncated } = await this.listReposForToken(pat)
    return {
      items: items.map((r) => ({ ...r, installationId, linkedVia: 'app' as const })),
      ...(truncated !== undefined ? { truncated } : {}),
    }
  }

  // A PAT can't scope `/search/repositories` to "my accessible repos" (it searches all
  // of GitHub), so the realtime picker search reuses the PAT's own `/user/repos`
  // enumeration and filters `owner/name` in memory — bounded to a developer's repo set,
  // which is exactly why the App-installation truncation this override fixes elsewhere
  // doesn't bite here. The account-scope opts are irrelevant (the enumeration is already
  // scoped to the PAT's affiliations). This is the picker typeahead's hot path, so the
  // enumeration is served through the short-TTL cache when one is wired — a keystroke then
  // costs a substring scan of the cached set, not a fresh multi-page walk. A transient
  // enumeration failure caches nothing (the load rejects) and propagates, as before.
  override async searchInstallationRepos(
    installationId: number,
    query: string,
    opts: { limit?: number } = {},
  ): Promise<GitHubRepo[]> {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const cacheKey = String(installationId)
    const items = this.repoEnumCache
      ? await this.repoEnumCache.get(
          cacheKey,
          cacheKey,
          async () => (await this.listInstallationRepos(installationId)).items,
        )
      : (await this.listInstallationRepos(installationId)).items
    const matched = items.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
    return matched.slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 100))
  }
}

/**
 * Read the PAT's own account (`GET /user`) so a synthetic installation can be attributed
 * to it in the connect UI. Best-effort: a failed/forbidden call falls back to an empty
 * login (the link flow only needs the installation row to exist, not its account label).
 */
export async function fetchPatAccount(
  env: NodeJS.ProcessEnv,
  pat: string | undefined,
): Promise<PatAccount> {
  const fallback: PatAccount = { accountId: null, accountLogin: '', targetType: 'User' }
  if (!pat) return fallback
  const apiBase = (env.GITHUB_API_BASE?.trim() || 'https://api.github.com').replace(/\/+$/, '')
  try {
    const res = await fetch(`${apiBase}/user`, { headers: patHeaders(pat) })
    if (!res.ok) return fallback
    const user = (await res.json()) as { id?: number; login?: string; type?: string }
    return {
      accountId: user.id != null ? String(user.id) : null,
      accountLogin: user.login ?? '',
      targetType: user.type === 'Organization' ? 'Organization' : 'User',
    }
  } catch {
    return fallback
  }
}

/**
 * Verdict of the optional boot-time GITHUB_PAT probe ({@link probeGitHubPat}). `ok` means the token
 * authenticated and — for a classic token whose scopes GitHub reports — carries the scopes local
 * mode needs; the failure variants each name what to fix.
 */
export type PatProbeVerdict =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'forbidden'; detail: string }
  | { ok: false; reason: 'underscoped'; missing: string[] }

/**
 * Classify a `GET /user` probe of the local-mode GITHUB_PAT into an actionable verdict. Pure, so the
 * mapping is unit-tested without a live token. `scopesHeader` is GitHub's `x-oauth-scopes` response
 * header: a CLASSIC token lists its granted scopes there (so an under-scoped token is detectable),
 * while a FINE-GRAINED token returns it empty/absent — scopes can't be verified from it, so we do
 * NOT false-warn (a successful call is taken as good enough).
 */
export function classifyPatProbe(res: {
  status: number
  scopesHeader: string | null
}): PatProbeVerdict {
  if (res.status === 401) {
    return { ok: false, reason: 'invalid', detail: 'HTTP 401 — invalid, expired, or revoked' }
  }
  if (res.status === 403) {
    return {
      ok: false,
      reason: 'forbidden',
      detail: 'HTTP 403 — rejected (SSO not authorized, or rate limited)',
    }
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: 'forbidden', detail: `HTTP ${res.status} — unexpected response` }
  }
  // 2xx: the token authenticates. Verify scopes only when GitHub reports them (classic token).
  const granted = (res.scopesHeader ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (granted.length === 0) return { ok: true } // fine-grained token — scopes not reported
  const missing = LOCAL_PAT_SCOPES.filter((s) => !granted.includes(s))
  return missing.length === 0
    ? { ok: true }
    : { ok: false, reason: 'underscoped', missing: [...missing] }
}

/**
 * Best-effort boot-time validation of the deployment's GitHub PAT: one `GET /user`. Returns the
 * verdict, or undefined when there is no PAT to probe or the probe couldn't complete (network error / timeout) —
 * a probe must NEVER block or crash boot, so an unreachable GitHub is treated as "unknown", not a
 * failure. `fetchImpl` + `timeoutMs` are injectable for tests.
 */
export async function probeGitHubPat(
  env: NodeJS.ProcessEnv,
  pat: string | undefined,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PatProbeVerdict | undefined> {
  if (!pat) return undefined
  const apiBase = (env.GITHUB_API_BASE?.trim() || 'https://api.github.com').replace(/\/+$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  try {
    const res = await doFetch(`${apiBase}/user`, {
      headers: patHeaders(pat),
      signal: controller.signal,
    })
    return classifyPatProbe({ status: res.status, scopesHeader: res.headers.get('x-oauth-scopes') })
  } catch {
    return undefined // network error / timeout — best-effort, stay silent
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The boot warning for a non-OK {@link probeGitHubPat} verdict (undefined when the PAT is fine).
 * Mirrors the MISSING-PAT boot warning: it names the exact problem and links the classic-token
 * creation URL with the local-mode scopes pre-selected, so the fix is one click. It names BOTH
 * ways to apply the replacement, because the token it just rejected may have come from either:
 * `.env` (which the sign-in screen will not override) or a previous browser install.
 */
export function describePatProbeVerdict(verdict: PatProbeVerdict): string | undefined {
  if (verdict.ok) return undefined
  const tail =
    `agent steps that clone, push, open PRs, gate on CI or merge will fail. Create a token ` +
    `(scopes pre-selected) at ${githubPatCreationUrl()}, then sign in with it on the sign-in ` +
    `screen, or set GITHUB_PAT in your .env and restart.`
  if (verdict.reason === 'underscoped') {
    return `local mode: the configured GitHub token is missing required scope(s) ${verdict.missing.join(', ')} — ${tail}`
  }
  return `local mode: the configured GitHub token was rejected by GitHub (${verdict.detail}) — ${tail}`
}

/**
 * Fire the boot-time {@link probeGitHubPat} check WITHOUT blocking boot (app-startup initiative,
 * item 6), logging {@link describePatProbeVerdict}'s warning (if any) when the bounded github.com
 * round-trip later resolves. The probe is best-effort diagnostics — an invalid / expired /
 * under-scoped PAT still fails LOUDLY on the first clone/push/PR/CI/merge — so it must not hold the
 * listener for a network hop to github.com. Returns immediately; never throws (`probeGitHubPat`
 * swallows network errors and the resolution handler is defensively guarded). `fetchImpl` +
 * `timeoutMs` are injectable for tests.
 */
export function warnOnGitHubPatProblemInBackground(
  env: NodeJS.ProcessEnv,
  pat: string | undefined,
  log: Logger,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): void {
  void runBestEffort(log, 'github.patProbe', async () => {
    const verdict = await probeGitHubPat(env, pat, opts)
    const warning = describePatProbeVerdict(verdict ?? { ok: true })
    if (warning) log.warn(warning)
  })
}

/**
 * A GitLab "new personal access token" URL with the scopes a coding agent needs
 * pre-selected, so a developer without a GitLab PAT can click straight through to create
 * one. `api` covers repo read/write + merge; `read_user` lets the login resolve the
 * account identity.
 */
export function gitlabPatCreationUrl(): string {
  const params = new URLSearchParams({
    name: 'cat-factory local mode',
    'scopes[]': 'api',
  })
  return `https://gitlab.com/-/user_settings/personal_access_tokens?${params.toString()}`
}

/**
 * Assemble the source-control PAT-login registry — the provider-agnostic seam the `/auth/pat`
 * endpoint resolves through. A provider is "configured" (one-click sign-in available) when the
 * deployment holds ITS token, read LIVE from `credential` so a token installed from the sign-in
 * screen turns the button on for the next caller. The browser never sees a token — one-click
 * sign-in just selects a provider. Adding a third provider is one more entry here + its resolver,
 * with no change to the endpoint or the UI flow.
 */
export function buildVcsIdentityRegistry(
  env: NodeJS.ProcessEnv,
  credential: () => LocalVcsCredential | undefined,
): VcsIdentityRegistry {
  const githubApiBase = env.GITHUB_API_BASE?.trim() || 'https://api.github.com'
  const gitlabApiBase = env.GITLAB_API_BASE?.trim() || undefined
  const tokenFor = (provider: VcsProvider) => () => {
    const current = credential()
    return current?.provider === provider ? current.token : undefined
  }
  return {
    github: {
      resolver: new GitHubIdentityResolver({ apiBase: githubApiBase }),
      configuredToken: tokenFor('github'),
    },
    gitlab: {
      resolver: new GitLabIdentityResolver({ apiBase: gitlabApiBase }),
      configuredToken: tokenFor('gitlab'),
    },
  }
}

/**
 * Build a {@link GitHubClient} that authenticates with the deployment's GitHub PAT, for the CI /
 * merge / mergeability gates AND the repo-link / board "add from repo" flows. Always returns a
 * client: the token is read per call, so "no token yet" is a REFUSAL the client raises (naming
 * how to fix it) rather than an absent client — which the layers above would otherwise read as
 * "this deployment has no source control at all" and wire nothing, permanently.
 * `repoEnumCache` is the `AppCaches.patInstallationRepos` handle backing the picker typeahead
 * (optional — absent, the search enumerates live per request).
 */
export function createLocalGitHubClient(
  env: NodeJS.ProcessEnv,
  resolveToken: () => string | undefined,
  repoEnumCache?: GroupCacheHandle<GitHubRepo[]>,
): GitHubClient {
  const apiBase = env.GITHUB_API_BASE?.trim() || 'https://api.github.com'
  return new PatGitHubClient(
    {
      registry: new LocalPatAppTokenSource(resolveToken),
      rateLimitRepository: new NoopRateLimitRepository(),
      idGenerator: localIdGenerator,
      clock: localClock,
      apiBase,
    },
    resolveToken,
    repoEnumCache,
  )
}

/**
 * Build a {@link GitHubClient} over a mothership-delegated {@link AppTokenSource}
 * (mothership mode with no local `GITHUB_PAT`): every installation token is minted by the
 * mothership's GitHub App via `POST /internal/github/installation-token`, so the CI /
 * merge / mergeability gates AND the repo-link / "add from repo" flows hit real GitHub on
 * the org's App installation — without the App private key (or any long-lived credential)
 * ever reaching this machine. Unlike the PAT client, the BASE `FetchGitHubClient` repo
 * enumeration (`/installation/repositories`) works as-is: the delegated token IS a real
 * App installation token.
 */
export function createDelegatedGitHubClient(
  env: NodeJS.ProcessEnv,
  tokenSource: AppTokenSource,
): GitHubClient {
  const apiBase = env.GITHUB_API_BASE?.trim() || 'https://api.github.com'
  return new FetchGitHubClient({
    registry: tokenSource,
    rateLimitRepository: new NoopRateLimitRepository(),
    idGenerator: localIdGenerator,
    clock: localClock,
    apiBase,
  })
}

/**
 * Build a {@link GitHubClient} for a GitLab-only local deployment, through the SAME
 * {@link buildGitLabEngineClient} the hosted facades use — a PAT-backed `VcsClient` adapted to the
 * legacy `GitHubClient` port the CI / merge / mergeability gates + repo-link flows still consume.
 * So a developer whose credential is a GitLab one gets the same gating/merge/repo-read surface a
 * GitHub PAT gives — the engine talks to GitLab through the adapter without being migrated to
 * the neutral port. Like {@link createLocalGitHubClient} it is always built and reads its token
 * per call, so an installed credential is live immediately. For a self-managed instance set
 * `GITLAB_API_BASE` (e.g. `https://gitlab.example.com/api/v4`).
 *
 * It goes THROUGH the builder rather than assembling the client + adapter pair itself, which is
 * what it did until that drifted: the builder is documented as the single source of this wiring,
 * so anything it gained reached the two hosted facades and silently skipped local.
 */
export function createLocalGitLabClient(
  env: NodeJS.ProcessEnv,
  resolveToken: () => string | undefined,
): GitHubClient {
  const apiBase = env.GITLAB_API_BASE?.trim() || GITLAB_PUBLIC_API_BASE
  return buildGitLabEngineClient({ token: resolveToken, apiBase, clock: localClock, logger })
}
