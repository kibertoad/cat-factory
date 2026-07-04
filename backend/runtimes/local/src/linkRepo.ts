import { randomUUID } from 'node:crypto'
import { type DrizzleDb, createDbClient, schema } from '@cat-factory/node-server'
import { and, eq, ne } from 'drizzle-orm'
import { syntheticInstallationId } from './installations.js'

// Link a real GitHub repo to a board service frame for LOCAL mode. Container agent
// steps resolve which repo to operate on from the account-owned `Service` bound to the
// enclosing frame (`buildResolveRepoTarget` walks the block ancestry to it). The cloud
// facades populate the projection from the GitHub App connect/sync flow; local mode has
// no App, so this helper seeds it directly from the repo's public metadata read with the
// PAT:
//   - a synthetic per-workspace `github_installations` row (the executor's PAT token
//     source ignores the installation id, but `resolveRepoTarget` requires a row to
//     exist + reads its id back),
//   - a `github_repos` row (the projected repo the resolver reads owner/name/branch from),
//     and
//   - the frame's `Service` bound to the repo (`repo_github_id` + `installation_id`) — the
//     sole repo↔frame linkage. An existing service (created when the frame was added on the
//     board) is updated in place; if the frame has none yet, one is inserted + mounted.
// Idempotent: re-linking the same repo/frame updates the rows in place.

const GITHUB_API_BASE = 'https://api.github.com'

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
    // `github_installations` has a partial UNIQUE index on (workspace_id) WHERE
    // deleted_at IS NULL, so a pre-existing live row for this workspace under a DIFFERENT
    // id (e.g. from a real GitHub-App connect) would collide with our synthetic-id
    // insert — and the upsert below keys on installation_id, not workspace_id, so it
    // wouldn't catch it. Clear any such row first so re-linking is robust.
    await db
      .delete(schema.githubInstallations)
      .where(
        and(
          eq(schema.githubInstallations.workspace_id, options.workspaceId),
          ne(schema.githubInstallations.installation_id, installationId),
        ),
      )
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
      is_monorepo: 0,
      // Local mode's single `GITHUB_PAT` is the workspace-wide credential every member
      // shares (its analogue of the shared App installation), so a linked repo is
      // `'app'`-reachable, not a per-user `'user_pat'` repo.
      linked_via: 'app',
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

    // Bind the frame's account-owned Service to the repo — the sole linkage
    // `resolveRepoTarget` reads. Update the service the board created for the frame; if
    // the frame has none (seeded/headless), insert one and mount it on the workspace.
    const existing = await db
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(eq(schema.services.frame_block_id, options.frameBlockId))
      .limit(1)
    if (existing[0]) {
      await db
        .update(schema.services)
        .set({ installation_id: installationId, repo_github_id: meta.id })
        .where(eq(schema.services.id, existing[0].id))
    } else {
      const workspaceRow = await db
        .select({ account_id: schema.workspaces.account_id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, options.workspaceId))
        .limit(1)
      const serviceId = `svc_${randomUUID()}`
      await db.insert(schema.services).values({
        id: serviceId,
        account_id: workspaceRow[0]?.account_id ?? null,
        frame_block_id: options.frameBlockId,
        installation_id: installationId,
        repo_github_id: meta.id,
        directory: null,
        created_at: now,
      })
      await db
        .insert(schema.workspaceServices)
        .values({
          workspace_id: options.workspaceId,
          service_id: serviceId,
          pos_x: 0,
          pos_y: 0,
          width: null,
          height: null,
          created_at: now,
        })
        .onConflictDoNothing()
    }
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
