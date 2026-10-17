import type { InfraSetup, InfraSetupOwners, InfraSetupStatus } from '@cat-factory/contracts'
import { isInfraSetupHealthStatus } from '@cat-factory/contracts'
import type { ProviderConnectionKind } from '~/types/providerConnections'
import { setupRemedyFor, type SetupActor, type SetupRemedy } from '~/utils/setupAudience'

// ---------------------------------------------------------------------------
// The setup checklist: what this workspace needs before a task can run and merge, as ONE list.
//
// Every row is composed from a probe that already exists and already drives a banner or a
// startup dialog (`useAiReadiness`, the GitHub probe, `workspace.infraSetup`, the provider
// connections' missing-required fields). The checklist adds no probe of its own: it states the
// same facts in one place, with a finish line, instead of one interruption per missing piece.
// Who may act on a row is the banners' rule too (`utils/setupAudience.ts`).
// ---------------------------------------------------------------------------

/** The rows. The infrastructure rows are named by their `InfraSetupArea`, the server's vocabulary. */
export const SETUP_ROWS = [
  'model',
  'sourceControl',
  'agentExecutor',
  'ephemeralEnvironments',
  'binaryStorage',
] as const
export type SetupRowId = (typeof SETUP_ROWS)[number]

/**
 * A row's state. Five, because they need five different reactions:
 *
 * - `done`: nothing to do.
 * - `missing`: never set up. The fix is to connect something.
 * - `attention`: set up, but broken, unreachable or incomplete. The fix is to repair it, and
 *   saying "connect" would send the reader to create a second one. Its {@link SetupRowCause} says
 *   which, because each needs a different fix.
 * - `checking`: the probe has not answered. Never rendered as missing: an unanswered probe and
 *   an absent capability are opposite facts.
 * - `not_needed`: this deployment does not use the area at all. Left out of the count.
 */
export type SetupRowStatus = 'done' | 'missing' | 'attention' | 'checking' | 'not_needed'

/** Why a row needs attention. Each one names a different fix. */
export type SetupRowCause =
  /** Configured, and its live probe says it cannot be reached. */
  | 'unreachable'
  /** Connected, but a mandatory provider field is unset. */
  | 'incomplete'
  /** GitHub refused the access token outright. */
  | 'rejected'
  /** The token authenticates but cannot push or open pull requests. */
  | 'underscoped'
  /** Usable models exist, but the default preset names one that is not. */
  | 'presetBroken'
  /** The probe itself failed, so the answer is unknown. The fix is to ask again. */
  | 'probeFailed'
  /** The workspace loaded, and this backend does not report the area at all. */
  | 'notReported'

/** Whether a task can run without the row. An optional row only switches off the agents that use it. */
export const SETUP_ROW_REQUIRED: Record<SetupRowId, boolean> = {
  model: true,
  sourceControl: true,
  agentExecutor: true,
  ephemeralEnvironments: false,
  binaryStorage: false,
}

/** Everything the checklist reads, resolved by the caller so this stays pure. */
export interface SetupProbeInput {
  readonly model: {
    /** The per-workspace model catalog has loaded for this workspace. */
    readonly loaded: boolean
    /** The last attempt to load it failed. */
    readonly loadFailed: boolean
    readonly usable: boolean
    /** Usable models exist, but the default preset names one that is not. */
    readonly presetBroken: boolean
  }
  readonly sourceControl: {
    /** Null while the GitHub probe is in flight. */
    readonly available: boolean | null
    /** Why `available` is false: switched off by the deployment, or the probe failed. */
    readonly unavailableCause: 'disabled' | 'failed' | null
    readonly connected: boolean
    /** Local mode with no personal access token set. */
    readonly patMissing: boolean
    /** The token check's verdict, when it needs attention. */
    readonly patProblem: 'rejected' | 'underscoped' | null
  }
  /** Null until the workspace snapshot has delivered it, or from a backend that omits it. */
  readonly infra: InfraSetup | null
  /** The workspace snapshot has loaded, so a null `infra` is an answer, not a wait. */
  readonly workspaceLoaded: boolean
  /** Who can close each infrastructure gap; null from a backend that does not report it. */
  readonly infraOwners: InfraSetupOwners | null
  readonly providers: {
    /** The provider connections have loaded, so `needingConfig` is an answer. */
    readonly loaded: boolean
    /** Provider connections that are wired but miss a mandatory field. */
    readonly needingConfig: readonly ProviderConnectionKind[]
  }
  readonly actor: SetupActor
}

/** A row's state and, exactly when it needs attention, why. */
export type SetupRowState =
  | { readonly status: Exclude<SetupRowStatus, 'attention'>; readonly cause: null }
  | { readonly status: 'attention'; readonly cause: SetupRowCause }

export type SetupRow = SetupRowState & {
  readonly id: SetupRowId
  readonly required: boolean
  /** Null when this caller can act on the row; otherwise how the gap gets fixed. */
  readonly remedy: SetupRemedy | null
}

export interface SetupChecklist {
  readonly rows: SetupRow[]
  /** Rows that count toward the finish line (everything except `not_needed`). */
  readonly total: number
  readonly done: number
  /** A counted row has not answered yet, so `done` is not a count of the finished rows yet. */
  readonly checking: boolean
}

type RowState = SetupRowState
const state = (status: Exclude<SetupRowStatus, 'attention'>): RowState => ({ status, cause: null })
const attention = (cause: SetupRowCause): RowState => ({ status: 'attention', cause })

function infraRow(
  status: InfraSetupStatus | undefined,
  workspaceLoaded: boolean,
  provider: { loaded: boolean; incomplete: boolean } | null,
): RowState {
  if (status === undefined) return workspaceLoaded ? attention('notReported') : state('checking')
  if (status === 'not_applicable') return state('not_needed')
  if (status === 'not_defined') return state('missing')
  if (isInfraSetupHealthStatus(status)) return attention('unreachable')
  // Configured. Whether a mandatory field is unset is known only once the providers load; until
  // then the row has not answered, rather than claiming done.
  if (provider && !provider.loaded) return state('checking')
  return provider?.incomplete ? attention('incomplete') : state('done')
}

function modelRow(m: SetupProbeInput['model']): RowState {
  if (!m.loaded) return m.loadFailed ? attention('probeFailed') : state('checking')
  if (!m.usable) return state('missing')
  return m.presetBroken ? attention('presetBroken') : state('done')
}

function sourceControlRow(s: SetupProbeInput['sourceControl']): RowState {
  if (s.patMissing) return state('missing')
  if (s.patProblem) return attention(s.patProblem)
  if (s.connected) return state('done')
  if (s.available === null) return state('checking')
  if (s.available === false) {
    if (s.unavailableCause === 'disabled') return state('not_needed')
    if (s.unavailableCause === 'failed') return attention('probeFailed')
  }
  return state('missing')
}

/**
 * Who closes a row's gap. Infrastructure follows its reported owner. A personal access token is
 * fixed by whoever holds it: the remedy is a token page, not a workspace setting, so every caller
 * gets the link. A model or a GitHub connection is a workspace setting.
 */
function rowOwner(id: SetupRowId, input: SetupProbeInput): unknown {
  switch (id) {
    case 'agentExecutor':
      return input.infraOwners?.agentExecutor
    case 'ephemeralEnvironments':
      return input.infraOwners?.ephemeralEnvironments
    case 'binaryStorage':
      return input.infraOwners?.binaryStorage
    case 'model':
      return 'workspace_admin'
    case 'sourceControl':
      return input.sourceControl.patMissing || input.sourceControl.patProblem
        ? null
        : 'workspace_admin'
    default: {
      const unreachable: never = id
      return unreachable
    }
  }
}

function remedyFor(owner: unknown, actor: SetupActor): SetupRemedy | null {
  return owner === null ? null : setupRemedyFor(owner, actor)
}

export function deriveSetupChecklist(input: SetupProbeInput): SetupChecklist {
  const { loaded, needingConfig } = input.providers
  const states: Record<SetupRowId, RowState> = {
    model: modelRow(input.model),
    sourceControl: sourceControlRow(input.sourceControl),
    agentExecutor: infraRow(input.infra?.agentExecutor, input.workspaceLoaded, {
      loaded,
      incomplete: needingConfig.includes('runner-pool'),
    }),
    ephemeralEnvironments: infraRow(input.infra?.ephemeralEnvironments, input.workspaceLoaded, {
      loaded,
      incomplete: needingConfig.includes('environment'),
    }),
    // Storage has no provider connection, so nothing about it waits on the providers.
    binaryStorage: infraRow(input.infra?.binaryStorage, input.workspaceLoaded, null),
  }
  const rows = SETUP_ROWS.map((id) => ({
    id,
    ...states[id],
    required: SETUP_ROW_REQUIRED[id],
    remedy: remedyFor(rowOwner(id, input), input.actor),
  }))
  const counted = rows.filter((r) => r.status !== 'not_needed')
  return {
    rows,
    total: counted.length,
    done: counted.filter((r) => r.status === 'done').length,
    checking: counted.some((r) => r.status === 'checking'),
  }
}
