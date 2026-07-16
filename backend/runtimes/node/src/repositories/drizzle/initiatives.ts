// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import type {
  Initiative,
  InitiativeRepository,
  RiskPolicy,
  RiskPolicyRepository,
  SharedStack,
  SharedStackRepository,
} from '@cat-factory/kernel'
import { decodeInitiativeRow } from '@cat-factory/contracts'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { initiatives, riskPolicies, sharedStacks } from '../../db/schema.js'

// The row → entity decode (doc blob + column-lifted keys) is the shared
// `decodeInitiativeRow` (contracts), so the Drizzle and D1 repos can't drift.
const rowToInitiative = decodeInitiativeRow

/**
 * Initiatives over Postgres — the Drizzle mirror of the Worker's
 * `D1InitiativeRepository` (migration 0035). Behaviourally identical so the
 * cross-runtime conformance suite asserts the same CRUD + rev-guarded CAS against
 * both stores.
 */

export class DrizzleInitiativeRepository implements InitiativeRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<Initiative | null> {
    const rows = await this.db
      .select()
      .from(initiatives)
      .where(and(eq(initiatives.workspace_id, workspaceId), eq(initiatives.id, id)))
      .limit(1)
    return rows[0] ? rowToInitiative(rows[0]) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<Initiative | null> {
    const rows = await this.db
      .select()
      .from(initiatives)
      .where(and(eq(initiatives.workspace_id, workspaceId), eq(initiatives.block_id, blockId)))
      .limit(1)
    return rows[0] ? rowToInitiative(rows[0]) : null
  }

  async list(workspaceId: string): Promise<Initiative[]> {
    const rows = await this.db
      .select()
      .from(initiatives)
      .where(eq(initiatives.workspace_id, workspaceId))
      .orderBy(asc(initiatives.created_at))
    // Snapshot-facing list read: drop a corrupt row rather than failing the board load.
    return rows.map(rowToInitiative).filter((i): i is Initiative => i !== null)
  }

  async listExecuting(): Promise<Array<{ workspaceId: string; initiative: Initiative }>> {
    const rows = await this.db
      .select()
      .from(initiatives)
      .where(eq(initiatives.status, 'executing'))
      .orderBy(asc(initiatives.created_at))
    return rows
      .map((row) => {
        const initiative = rowToInitiative(row)
        return initiative ? { workspaceId: row.workspace_id, initiative } : null
      })
      .filter((r): r is { workspaceId: string; initiative: Initiative } => r !== null)
  }

  async insert(workspaceId: string, initiative: Initiative): Promise<void> {
    await this.db.insert(initiatives).values({
      workspace_id: workspaceId,
      id: initiative.id,
      block_id: initiative.blockId,
      slug: initiative.slug,
      status: initiative.status,
      rev: initiative.rev,
      doc: JSON.stringify(initiative),
      created_at: initiative.createdAt,
      updated_at: initiative.updatedAt,
    })
  }

  async compareAndSwap(
    workspaceId: string,
    next: Initiative,
    expectedRev: number,
  ): Promise<boolean> {
    const result = await this.db
      .update(initiatives)
      .set({
        slug: next.slug,
        status: next.status,
        rev: next.rev,
        doc: JSON.stringify(next),
        updated_at: next.updatedAt,
      })
      .where(
        and(
          eq(initiatives.workspace_id, workspaceId),
          eq(initiatives.id, next.id),
          eq(initiatives.rev, expectedRev),
        ),
      )
    return (result.rowCount ?? 0) > 0
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(initiatives)
      .where(and(eq(initiatives.workspace_id, workspaceId), eq(initiatives.id, id)))
  }
}

type RiskPolicyRow = typeof riskPolicies.$inferSelect

function rowToRiskPolicy(row: RiskPolicyRow): RiskPolicy {
  return {
    id: row.id,
    name: row.name,
    maxComplexity: row.max_complexity,
    maxRisk: row.max_risk,
    maxImpact: row.max_impact,
    ciMaxAttempts: row.ci_max_attempts,
    maxRequirementIterations: row.max_requirement_iterations,
    maxRequirementConcernAllowed:
      row.max_requirement_concern_allowed as RiskPolicy['maxRequirementConcernAllowed'],
    maxTesterQualityIterations: row.max_tester_quality_iterations,
    releaseWatchWindowMinutes: row.release_watch_window_minutes,
    releaseMaxAttempts: row.release_max_attempts,
    humanReviewGraceMinutes: row.human_review_grace_minutes,
    autoMergeEnabled: row.auto_merge_enabled === 1,
    forkDecision: row.fork_decision
      ? (JSON.parse(row.fork_decision) as RiskPolicy['forkDecision'])
      : null,
    isDefault: row.is_default === 1,
    ...(row.version != null ? { version: row.version } : {}),
    createdAt: row.created_at,
  }
}

/**
 * Per-workspace merge threshold presets over Postgres (the Drizzle mirror of the
 * Worker's `D1RiskPolicyRepository`, migration 0024). Enforces the single-default
 * invariant: promoting a preset to default demotes every other in the workspace
 * before the upsert. The default preset cannot be removed (the service keeps that
 * rule too; the DELETE also guards `is_default = 0`). Behaviourally identical to the
 * D1 repo so the cross-runtime conformance suite asserts the same preset resolution.
 */

export class DrizzleRiskPolicyRepository implements RiskPolicyRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<RiskPolicy | null> {
    const rows = await this.db
      .select()
      .from(riskPolicies)
      .where(and(eq(riskPolicies.workspace_id, workspaceId), eq(riskPolicies.id, id)))
      .limit(1)
    return rows[0] ? rowToRiskPolicy(rows[0]) : null
  }

  async list(workspaceId: string): Promise<RiskPolicy[]> {
    const rows = await this.db
      .select()
      .from(riskPolicies)
      .where(eq(riskPolicies.workspace_id, workspaceId))
      .orderBy(riskPolicies.created_at)
    return rows.map(rowToRiskPolicy)
  }

  async getDefault(workspaceId: string): Promise<RiskPolicy | null> {
    const rows = await this.db
      .select()
      .from(riskPolicies)
      .where(and(eq(riskPolicies.workspace_id, workspaceId), eq(riskPolicies.is_default, 1)))
      .orderBy(riskPolicies.created_at)
      .limit(1)
    return rows[0] ? rowToRiskPolicy(rows[0]) : null
  }

  async upsert(workspaceId: string, preset: RiskPolicy): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: preset.id,
      name: preset.name,
      max_complexity: preset.maxComplexity,
      max_risk: preset.maxRisk,
      max_impact: preset.maxImpact,
      ci_max_attempts: preset.ciMaxAttempts,
      max_requirement_iterations: preset.maxRequirementIterations,
      max_requirement_concern_allowed: preset.maxRequirementConcernAllowed,
      max_tester_quality_iterations: preset.maxTesterQualityIterations,
      release_watch_window_minutes: preset.releaseWatchWindowMinutes,
      release_max_attempts: preset.releaseMaxAttempts,
      human_review_grace_minutes: preset.humanReviewGraceMinutes,
      auto_merge_enabled: preset.autoMergeEnabled ? 1 : 0,
      fork_decision: preset.forkDecision ? JSON.stringify(preset.forkDecision) : null,
      version: preset.version ?? null,
      is_default: preset.isDefault ? 1 : 0,
      created_at: preset.createdAt,
    }
    // Demote + upsert run in one transaction so the single-default invariant can never
    // be observed broken (zero or two defaults) by a concurrent reader or a partial failure.
    await this.db.transaction(async (tx) => {
      // Promoting this preset to default demotes any other default first.
      if (preset.isDefault) {
        await tx
          .update(riskPolicies)
          .set({ is_default: 0 })
          .where(
            and(
              eq(riskPolicies.workspace_id, workspaceId),
              sql`${riskPolicies.id} <> ${preset.id}`,
            ),
          )
      }
      await tx
        .insert(riskPolicies)
        .values(values)
        .onConflictDoUpdate({
          target: [riskPolicies.workspace_id, riskPolicies.id],
          set: {
            name: values.name,
            max_complexity: values.max_complexity,
            max_risk: values.max_risk,
            max_impact: values.max_impact,
            ci_max_attempts: values.ci_max_attempts,
            max_requirement_iterations: values.max_requirement_iterations,
            max_requirement_concern_allowed: values.max_requirement_concern_allowed,
            max_tester_quality_iterations: values.max_tester_quality_iterations,
            release_watch_window_minutes: values.release_watch_window_minutes,
            release_max_attempts: values.release_max_attempts,
            human_review_grace_minutes: values.human_review_grace_minutes,
            auto_merge_enabled: values.auto_merge_enabled,
            fork_decision: values.fork_decision,
            version: values.version,
            is_default: values.is_default,
          },
        })
    })
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(riskPolicies)
      .where(
        and(
          eq(riskPolicies.workspace_id, workspaceId),
          eq(riskPolicies.id, id),
          eq(riskPolicies.is_default, 0),
        ),
      )
  }
}

// Shape-guarded parsers matching the D1 mirror (`D1SharedStackRepository`) EXACTLY, so a
// malformed/hand-edited JSON column coerces identically on both stores (a non-array ⇒ `[]`, a
// non-object health gate ⇒ `null`) rather than the Node facade handing the domain a raw value the
// Worker would have dropped — the "keep the runtimes symmetric" guarantee holds for bad data too.
function parseSharedStackArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function parseSharedStackHealthGate(json: string | null): SharedStack['healthGate'] {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object'
      ? (parsed as NonNullable<SharedStack['healthGate']>)
      : null
  } catch {
    return null
  }
}

function rowToSharedStack(row: typeof sharedStacks.$inferSelect): SharedStack {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    cloneUrl: row.clone_url,
    gitRef: row.git_ref,
    composeFiles: parseSharedStackArray<SharedStack['composeFiles'][number]>(row.compose_files),
    composeProfiles: parseSharedStackArray<SharedStack['composeProfiles'][number]>(
      row.compose_profiles,
    ),
    envFiles: parseSharedStackArray<SharedStack['envFiles'][number]>(row.env_files),
    managedNetworks: parseSharedStackArray<SharedStack['managedNetworks'][number]>(
      row.managed_networks,
    ),
    setupSteps: parseSharedStackArray<SharedStack['setupSteps'][number]>(row.setup_steps),
    prerequisites: parseSharedStackArray<SharedStack['prerequisites'][number]>(row.prerequisites),
    healthGate: parseSharedStackHealthGate(row.health_gate),
    allowHostCommands: row.allow_host_commands === 1,
    status: row.status as SharedStack['status'],
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A workspace's shared stacks over Postgres (the Drizzle mirror of the Worker's
 * `D1SharedStackRepository`, migration 0041). JSON-shaped fields are stored as text JSON and
 * `allow_host_commands` as 0/1; behaviourally identical to the D1 repo so the cross-runtime
 * conformance suite asserts the same round-trip.
 */

export class DrizzleSharedStackRepository implements SharedStackRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<SharedStack | null> {
    const rows = await this.db
      .select()
      .from(sharedStacks)
      .where(and(eq(sharedStacks.workspace_id, workspaceId), eq(sharedStacks.id, id)))
      .limit(1)
    return rows[0] ? rowToSharedStack(rows[0]) : null
  }

  async list(workspaceId: string): Promise<SharedStack[]> {
    const rows = await this.db
      .select()
      .from(sharedStacks)
      .where(eq(sharedStacks.workspace_id, workspaceId))
      .orderBy(sharedStacks.created_at)
    return rows.map(rowToSharedStack)
  }

  async upsert(workspaceId: string, stack: SharedStack): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: stack.id,
      name: stack.name,
      clone_url: stack.cloneUrl,
      git_ref: stack.gitRef,
      compose_files: JSON.stringify(stack.composeFiles),
      compose_profiles: JSON.stringify(stack.composeProfiles),
      env_files: JSON.stringify(stack.envFiles),
      managed_networks: JSON.stringify(stack.managedNetworks),
      setup_steps: JSON.stringify(stack.setupSteps),
      prerequisites: JSON.stringify(stack.prerequisites),
      health_gate: stack.healthGate ? JSON.stringify(stack.healthGate) : null,
      allow_host_commands: stack.allowHostCommands ? 1 : 0,
      status: stack.status,
      last_error: stack.lastError,
      created_at: stack.createdAt,
      updated_at: stack.updatedAt,
    }
    await this.db
      .insert(sharedStacks)
      .values(values)
      .onConflictDoUpdate({
        target: [sharedStacks.workspace_id, sharedStacks.id],
        set: {
          name: values.name,
          clone_url: values.clone_url,
          git_ref: values.git_ref,
          compose_files: values.compose_files,
          compose_profiles: values.compose_profiles,
          env_files: values.env_files,
          managed_networks: values.managed_networks,
          setup_steps: values.setup_steps,
          prerequisites: values.prerequisites,
          health_gate: values.health_gate,
          allow_host_commands: values.allow_host_commands,
          status: values.status,
          last_error: values.last_error,
          updated_at: values.updated_at,
        },
      })
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(sharedStacks)
      .where(and(eq(sharedStacks.workspace_id, workspaceId), eq(sharedStacks.id, id)))
  }
}

// ---- Sandbox (parallel prompt/model testing surface; migration 0012) --------
// The Drizzle mirror of the Worker's five `D1Sandbox*Repository` classes. JSON-shaped
// fields are stored as text JSON, parsed defensively; behaviourally identical to the D1
// repos so the cross-runtime conformance suite asserts the same Sandbox behaviour.
