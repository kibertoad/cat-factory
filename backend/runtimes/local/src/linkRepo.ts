import { createHash } from 'node:crypto'
import { type DrizzleDb, createDbClient, schema } from '@cat-factory/node-server'

// Link a real GitHub repo to a board service frame for LOCAL mode. Container agent
// steps resolve which repo to operate on from the `github_repos` /
// `github_installations` projection (`buildResolveRepoTarget`). The cloud facades
// populate those rows from the GitHub App connect/sync flow; local mode has no App, so
// this helper seeds them directly from the repo's public metadata read with the PAT:
//   - a synthetic per-workspace `github_installations` row (the executor's PAT token
//     source ignores the installation id, but `resolveRepoTarget` requires a row to
//     exist + reads its id back), and
//   - a `github_repos` row linked to the frame via `block_id` (the legacy projection
//     link `resolveRepoTarget` walks the block ancestry to find).
// Idempotent: re-linking the same repo/frame updates the rows in place.

const GITHUB_API_BASE = 'https://api.github.com'

/** A stable, positive, safe-integer installation id derived from the workspace id. */
function syntheticInstallationId(workspaceId: string): number {
  // 48 bits keeps it well inside Number.MAX_SAFE_INTEGER and the bigint column; the
  // value is per-workspace (the table's workspace_id is unique) so two workspaces never
  // collide, and re-linking a workspace reuses the same id (upsert, not a new row).
  const hex = createHash('sha1').update(workspaceId).digest('hex').slice(0, 12)
  return Number.parseInt(hex, 16)
}

export interface LinkRepoOptions {
  /** The board workspace id. */
  workspaceId: string
  /** The service-frame block id tasks will sit under (the repo links to this). */
  frameBlockId: string
  /** The repository, as `owner/name`. */
  repo: string
  /** Pre-built Drizzle client; else one is opened from {@link databaseUrl}. */
  db?: DrizzleDb
  /** `DATABASE_URL`; required when {@link db} is not supplied. */
  databaseUrl?: string
  /** The PAT; defaults to `env.GITHUB_PAT`. */
  pat?: string
  /** GitHub API base; defaults to `env.GITHUB_API_BASE` or api.github.com. */
  apiBase?: string
  /** Environment source for the PAT / API base defaults. */
  env?: NodeJS.ProcessEnv
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch
}

export interface LinkedRepo {
  owner: string
  name: string
  githubId: number
  installationId: number
  defaultBranch: string
  private: boolean
}

export async function linkRepo(options: LinkRepoOptions): Promise<LinkedRepo> {
  const env = options.env ?? process.env
  const pat = options.pat ?? env.GITHUB_PAT?.trim()
  if (!pat) throw new Error('A GitHub PAT is required (set GITHUB_PAT or pass options.pat)')
  const apiBase = (options.apiBase ?? env.GITHUB_API_BASE?.trim() ?? GITHUB_API_BASE).replace(
    /\/+$/,
    '',
  )
  const slash = options.repo.indexOf('/')
  if (slash <= 0 || slash === options.repo.length - 1) {
    throw new Error(`Invalid repo '${options.repo}' — expected 'owner/name'`)
  }
  const owner = options.repo.slice(0, slash)
  const name = options.repo.slice(slash + 1)

  const fetchImpl = options.fetchImpl ?? fetch
  const res = await fetchImpl(`${apiBase}/repos/${owner}/${name}`, {
    headers: {
      authorization: `Bearer ${pat}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'cat-factory',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GitHub repo lookup failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  const meta = (await res.json()) as {
    id: number
    default_branch?: string
    private?: boolean
    owner?: { id?: number; login?: string; type?: string }
  }

  const installationId = syntheticInstallationId(options.workspaceId)
  const defaultBranch = meta.default_branch ?? 'main'
  const now = Date.now()

  let db = options.db
  let close: (() => Promise<void>) | undefined
  if (!db) {
    const url = options.databaseUrl ?? env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is required to link a repo (or pass options.db)')
    const client = createDbClient(url)
    db = client.db
    close = () => client.pool.end()
  }

  try {
    const installationValues = {
      installation_id: installationId,
      workspace_id: options.workspaceId,
      account_id: meta.owner?.id != null ? String(meta.owner.id) : null,
      account_login: meta.owner?.login ?? owner,
      target_type: meta.owner?.type === 'Organization' ? 'Organization' : 'User',
      app_id: null,
      cached_token: null,
      token_expires_at: null,
      created_at: now,
      deleted_at: null,
    }
    await db.insert(schema.githubInstallations).values(installationValues).onConflictDoUpdate({
      target: schema.githubInstallations.installation_id,
      set: installationValues,
    })

    const repoValues = {
      workspace_id: options.workspaceId,
      github_id: meta.id,
      installation_id: installationId,
      owner,
      name,
      default_branch: defaultBranch,
      private: meta.private ? 1 : 0,
      block_id: options.frameBlockId,
      is_monorepo: 0,
      etag: null,
      synced_at: now,
      deleted_at: null,
    }
    await db
      .insert(schema.githubRepos)
      .values(repoValues)
      .onConflictDoUpdate({
        target: [schema.githubRepos.workspace_id, schema.githubRepos.github_id],
        set: repoValues,
      })
  } finally {
    await close?.()
  }

  return {
    owner,
    name,
    githubId: meta.id,
    installationId,
    defaultBranch,
    private: Boolean(meta.private),
  }
}
