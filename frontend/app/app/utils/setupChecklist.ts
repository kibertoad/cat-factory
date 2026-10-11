import type { InfraSetup, InfraSetupStatus } from '@cat-factory/contracts'
import { isInfraSetupHealthStatus } from '@cat-factory/contracts'
import type { ProviderConnectionKind } from '~/types/providerConnections'

// ---------------------------------------------------------------------------
// The setup checklist: what this workspace needs before a task can run and merge, as ONE list.
//
// Every row is composed from a probe that already exists and already drives a banner or a
// startup dialog (`useAiReadiness`, the GitHub probe, `workspace.infraSetup`, the provider
// connections' missing-required fields). The checklist adds no probe of its own: it states the
// same facts in one place, with a finish line, instead of one interruption per missing piece.
// ---------------------------------------------------------------------------

export const SETUP_ROWS = [
  'model',
  'sourceControl',
  'agentExecutor',
  'testEnvironments',
  'contentStorage',
] as const
export type SetupRowId = (typeof SETUP_ROWS)[number]

/**
 * A row's state. Five, because they need five different reactions:
 *
 * - `done`: nothing to do.
 * - `missing`: never set up. The fix is to connect something.
 * - `attention`: set up, but broken, unreachable or incomplete. The fix is to repair it, and
 *   saying "connect" would send the reader to create a second one.
 * - `checking`: the probe has not answered. Never rendered as missing: an unanswered probe and
 *   an absent capability are opposite facts.
 * - `not_needed`: this deployment does not use the area at all. Left out of the count.
 */
export type SetupRowStatus = 'done' | 'missing' | 'attention' | 'checking' | 'not_needed'

/**
 * Whether a task can run without the row. A required row that is not `done` is what the queue's
 * one-line "this workspace cannot run tasks yet" is about; an optional one only switches off the
 * agents that use it.
 */
export const SETUP_ROW_REQUIRED: Record<SetupRowId, boolean> = {
  model: true,
  sourceControl: true,
  agentExecutor: true,
  testEnvironments: false,
  contentStorage: false,
}

/** Everything the checklist reads, resolved by the caller so this stays pure. */
export interface SetupProbeInput {
  readonly model: {
    /** The per-workspace model catalog has loaded for this workspace. */
    readonly loaded: boolean
    readonly usable: boolean
    /** Usable models exist, but the default preset names one that is not. */
    readonly presetBroken: boolean
  }
  readonly sourceControl: {
    /** Null while the GitHub probe is in flight; false when the deployment has it switched off. */
    readonly available: boolean | null
    readonly connected: boolean
    /** Local mode with no personal access token set. */
    readonly patMissing: boolean
    /** A token is set but GitHub rejected it, or it cannot push or open pull requests. */
    readonly patNeedsAttention: boolean
  }
  /** Null until the workspace snapshot has delivered it. */
  readonly infra: InfraSetup | null
  /** Provider connections that are wired but miss a mandatory field. */
  readonly needingConfig: readonly ProviderConnectionKind[]
}

export interface SetupRow {
  readonly id: SetupRowId
  readonly status: SetupRowStatus
  readonly required: boolean
}

export interface SetupChecklist {
  readonly rows: SetupRow[]
  /** Rows that count toward the finish line (everything except `not_needed`). */
  readonly total: number
  readonly done: number
  /** A required row is known to be not done, so no task can run yet. */
  readonly blocking: boolean
}

function infraRow(status: InfraSetupStatus | undefined, incomplete: boolean): SetupRowStatus {
  if (status === undefined) return 'checking'
  if (status === 'not_applicable') return 'not_needed'
  if (status === 'not_defined') return 'missing'
  if (isInfraSetupHealthStatus(status) || incomplete) return 'attention'
  return 'done'
}

function modelRow(m: SetupProbeInput['model']): SetupRowStatus {
  if (!m.loaded) return 'checking'
  if (!m.usable) return 'missing'
  return m.presetBroken ? 'attention' : 'done'
}

function sourceControlRow(s: SetupProbeInput['sourceControl']): SetupRowStatus {
  if (s.patMissing) return 'missing'
  if (s.patNeedsAttention) return 'attention'
  if (s.connected) return 'done'
  if (s.available === null) return 'checking'
  return 'missing'
}

export function deriveSetupChecklist(input: SetupProbeInput): SetupChecklist {
  const statuses: Record<SetupRowId, SetupRowStatus> = {
    model: modelRow(input.model),
    sourceControl: sourceControlRow(input.sourceControl),
    agentExecutor: infraRow(
      input.infra?.agentExecutor,
      input.needingConfig.includes('runner-pool'),
    ),
    testEnvironments: infraRow(
      input.infra?.ephemeralEnvironments,
      input.needingConfig.includes('environment'),
    ),
    contentStorage: infraRow(input.infra?.binaryStorage, false),
  }
  const rows = SETUP_ROWS.map((id) => ({
    id,
    status: statuses[id],
    required: SETUP_ROW_REQUIRED[id],
  }))
  const counted = rows.filter((r) => r.status !== 'not_needed')
  return {
    rows,
    total: counted.length,
    done: counted.filter((r) => r.status === 'done').length,
    blocking: rows.some((r) => r.required && (r.status === 'missing' || r.status === 'attention')),
  }
}
