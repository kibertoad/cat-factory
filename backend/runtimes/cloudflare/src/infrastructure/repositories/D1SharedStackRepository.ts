import type {
  RecipeEnvFile,
  RecipeHealthGate,
  RecipeStep,
  SharedStack,
  SharedStackRepository,
  SharedStackStatus,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface SharedStackRow {
  workspace_id: string
  id: string
  name: string
  clone_url: string
  git_ref: string | null
  compose_files: string
  compose_profiles: string
  env_files: string
  managed_networks: string
  setup_steps: string
  health_gate: string | null
  allow_host_commands: number
  status: string
  last_error: string | null
  created_at: number
  updated_at: number
}

function parseJsonArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function parseHealthGate(json: string | null): RecipeHealthGate | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as RecipeHealthGate) : null
  } catch {
    return null
  }
}

function rowToStack(row: SharedStackRow): SharedStack {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    cloneUrl: row.clone_url,
    gitRef: row.git_ref,
    composeFiles: parseJsonArray<string>(row.compose_files),
    composeProfiles: parseJsonArray<string>(row.compose_profiles),
    envFiles: parseJsonArray<RecipeEnvFile>(row.env_files),
    managedNetworks: parseJsonArray<string>(row.managed_networks),
    setupSteps: parseJsonArray<RecipeStep>(row.setup_steps),
    healthGate: parseHealthGate(row.health_gate),
    allowHostCommands: row.allow_host_commands === 1,
    status: row.status as SharedStackStatus,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A workspace's shared stacks — long-lived compose infra a consumer environment attaches
 * to over an external network (migration 0041). JSON-shaped fields (`compose_files`,
 * `compose_profiles`, `env_files`, `managed_networks`, `setup_steps`, `health_gate`) are
 * stored as text JSON; `allow_host_commands` as 0/1. Behaviourally identical to the Drizzle
 * mirror so the cross-runtime conformance suite asserts the same round-trip.
 */
export class D1SharedStackRepository implements SharedStackRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<SharedStack | null> {
    const row = await this.db
      .prepare(`SELECT * FROM shared_stacks WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<SharedStackRow>()
    return row ? rowToStack(row) : null
  }

  async list(workspaceId: string): Promise<SharedStack[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM shared_stacks WHERE workspace_id = ? ORDER BY created_at ASC`)
      .bind(workspaceId)
      .all<SharedStackRow>()
    return results.map(rowToStack)
  }

  async upsert(workspaceId: string, stack: SharedStack): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO shared_stacks
           (workspace_id, id, name, clone_url, git_ref, compose_files, compose_profiles,
            env_files, managed_networks, setup_steps, health_gate, allow_host_commands,
            status, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           name = excluded.name,
           clone_url = excluded.clone_url,
           git_ref = excluded.git_ref,
           compose_files = excluded.compose_files,
           compose_profiles = excluded.compose_profiles,
           env_files = excluded.env_files,
           managed_networks = excluded.managed_networks,
           setup_steps = excluded.setup_steps,
           health_gate = excluded.health_gate,
           allow_host_commands = excluded.allow_host_commands,
           status = excluded.status,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .bind(
        workspaceId,
        stack.id,
        stack.name,
        stack.cloneUrl,
        stack.gitRef,
        JSON.stringify(stack.composeFiles),
        JSON.stringify(stack.composeProfiles),
        JSON.stringify(stack.envFiles),
        JSON.stringify(stack.managedNetworks),
        JSON.stringify(stack.setupSteps),
        stack.healthGate ? JSON.stringify(stack.healthGate) : null,
        stack.allowHostCommands ? 1 : 0,
        stack.status,
        stack.lastError,
        stack.createdAt,
        stack.updatedAt,
      )
      .run()
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM shared_stacks WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .run()
  }
}
