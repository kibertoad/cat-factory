import { randomUUID } from 'node:crypto'
import type {
  Clock,
  GitHubClient,
  IdGenerator,
  RateLimitRepository,
  RateLimitSnapshot,
} from '@cat-factory/kernel'
import { type AppTokenSource, FetchGitHubClient } from '@cat-factory/server'

// PAT-backed GitHub access for local mode. The shared FetchGitHubClient normally mints
// per-installation tokens via the GitHub App registry; here we feed it a static-token
// source returning the developer's PAT, so the CI gate + merge / mergeability
// providers (wired in container.ts from this client) hit real GitHub with the PAT.
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

/** An {@link AppTokenSource} that returns a fixed PAT for every installation call. */
export class StaticTokenAppRegistry implements AppTokenSource {
  readonly defaultAppId = ''
  constructor(private readonly token: string) {}

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
    return Promise.resolve(this.token)
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

/**
 * Build a {@link GitHubClient} that authenticates with the PAT, for the CI / merge /
 * mergeability gates. Returns undefined when no PAT is configured (the gates then pass
 * through, like the Node default).
 */
export function createLocalGitHubClient(env: NodeJS.ProcessEnv): GitHubClient | undefined {
  const pat = env.GITHUB_PAT?.trim()
  if (!pat) return undefined
  const apiBase = env.GITHUB_API_BASE?.trim() || 'https://api.github.com'
  return new FetchGitHubClient({
    registry: new StaticTokenAppRegistry(pat),
    rateLimitRepository: new NoopRateLimitRepository(),
    idGenerator: localIdGenerator,
    clock: localClock,
    apiBase,
  })
}
