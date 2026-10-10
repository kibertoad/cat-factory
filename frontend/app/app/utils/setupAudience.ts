import { isInfraSetupHealthStatus, isInfraSetupOwner } from '@cat-factory/contracts'
import type { InfraSetup, InfraSetupArea, InfraSetupOwner, InfraSetupOwners } from '~/types/domain'

// Who a setup prompt is FOR. The infra-setup cards used to render for every caller, so a member,
// a viewer and a designer each got "Configure runner pool" buttons that opened screens their save
// would 403 on. The rule here keeps each card to the people who can act on it, and gives everyone
// else one line naming who can, but only when the gap stops their own work.

/** What the caller can do, as far as a setup prompt cares. */
export interface SetupActor {
  /** The full app surface (engineer / PM). The designer (`intake`) surface never configures. */
  fullSurface: boolean
  /** `integrations.manage` on the active board (true in dev-open, like every permission). */
  canManageIntegrations: boolean
  /** `runs.execute` on the active board: whether a gap that stops runs stops THEIR work. */
  canExecuteRuns: boolean
  /** An admin of the board's account. */
  isAccountAdmin: boolean
  /** Whether this deployment has accounts at all (auth on). */
  accountsEnabled: boolean
}

/**
 * The areas whose gap stops EVERY run, so a caller who cannot fix one still needs to know it is
 * there: without an executor no agent starts. A missing test environment or content storage only
 * degrades some runs, and the run that needs them already says so when it starts.
 */
export const BLOCKING_INFRA_AREAS = ['agentExecutor'] as const satisfies readonly InfraSetupArea[]
export type BlockingInfraArea = (typeof BLOCKING_INFRA_AREAS)[number]

/**
 * The owner to act on: the reported one when this build knows it, else the workspace admin, which
 * is who the cards assumed before the owner was reported. An older backend sends none; a newer one
 * may send an owner this bundle has never seen, and neither may break the board's render.
 */
export function effectiveOwner(owner: unknown): InfraSetupOwner {
  return isInfraSetupOwner(owner) ? owner : 'workspace_admin'
}

/** Whether the caller can close a gap owned by `owner` (any value; see {@link effectiveOwner}). */
export function canActOnSetup(owner: unknown, actor: SetupActor): boolean {
  if (!actor.fullSurface) return false
  const known = effectiveOwner(owner)
  switch (known) {
    case 'workspace_admin':
      return actor.canManageIntegrations
    case 'account_admin':
      // Without accounts there is no account admin to name, and the single user holds every
      // permission, so the workspace grant stands in for it.
      return actor.accountsEnabled ? actor.isAccountAdmin : actor.canManageIntegrations
    case 'operator':
      return false
    default: {
      // Compile-time exhaustiveness only: `effectiveOwner` already narrowed the runtime value.
      const unreachable: never = known
      return unreachable
    }
  }
}

/**
 * How a caller who cannot act on a gap from where they are CAN get it fixed: the owner to ask, or
 * `full_surface` when they hold the grant themselves and only the designer surface they chose hides
 * the card. Telling a board admin that "a board admin can fix this" would send them looking for
 * someone else.
 */
export type SetupRemedy = InfraSetupOwner | 'full_surface'

/** The line a caller who cannot act sees for a blocking gap. */
export interface SetupNotice {
  area: BlockingInfraArea
  /** `outage` when the area is configured but unreachable, else `setup`. */
  kind: 'setup' | 'outage'
  remedy: SetupRemedy
}

/**
 * The first blocking gap the caller cannot act on, or null. The caller who CAN act gets the full
 * card instead, so the two never describe the same gap twice, and a caller who cannot start a run
 * (a viewer) gets nothing: the gap does not stop anything they do.
 */
export function blockingSetupNotice(
  status: InfraSetup | null,
  owners: InfraSetupOwners | null,
  actor: SetupActor,
): SetupNotice | null {
  if (!status || !actor.canExecuteRuns) return null
  for (const area of BLOCKING_INFRA_AREAS) {
    const areaStatus = status[area]
    const kind = isInfraSetupHealthStatus(areaStatus)
      ? 'outage'
      : areaStatus === 'not_defined'
        ? 'setup'
        : null
    if (!kind) continue
    const owner = effectiveOwner(owners?.[area])
    if (canActOnSetup(owner, actor)) continue
    const remedy = canActOnSetup(owner, { ...actor, fullSurface: true }) ? 'full_surface' : owner
    return { area, kind, remedy }
  }
  return null
}
