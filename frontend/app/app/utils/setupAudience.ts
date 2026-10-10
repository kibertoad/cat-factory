import { isInfraSetupHealthStatus } from '@cat-factory/contracts'
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
 * Whether the caller can close a gap owned by `owner`. An unknown owner (an older backend) falls
 * back to the workspace admin, which is who the cards assumed before the owner was reported.
 */
export function canActOnSetup(owner: InfraSetupOwner | undefined, actor: SetupActor): boolean {
  if (!actor.fullSurface) return false
  switch (owner) {
    case undefined:
    case 'workspace_admin':
      return actor.canManageIntegrations
    case 'account_admin':
      // Without accounts there is no account admin to name, and the single user holds every
      // permission, so the workspace grant stands in for it.
      return actor.accountsEnabled ? actor.isAccountAdmin : actor.canManageIntegrations
    case 'operator':
      return false
    default:
      return assertNeverOwner(owner)
  }
}

/** Compile-time exhaustiveness for {@link canActOnSetup}, plus a refusal for a value past the type. */
function assertNeverOwner(owner: never): never {
  throw new Error(`Unknown infra-setup owner: ${String(owner)}`)
}

/** The line a caller who cannot act sees for a blocking gap. */
export interface SetupNotice {
  area: BlockingInfraArea
  /** `outage` when the area is configured but unreachable, else `setup`. */
  kind: 'setup' | 'outage'
  /** Who can fix it, for the copy. Defaults to the workspace admin on an older backend. */
  owner: InfraSetupOwner
}

/**
 * The first blocking gap the caller cannot act on, or null. The caller who CAN act gets the full
 * card instead, so the two never describe the same gap twice.
 */
export function blockingSetupNotice(
  status: InfraSetup | null,
  owners: InfraSetupOwners | null,
  actor: SetupActor,
): SetupNotice | null {
  if (!status) return null
  for (const area of BLOCKING_INFRA_AREAS) {
    const areaStatus = status[area]
    const kind = isInfraSetupHealthStatus(areaStatus)
      ? 'outage'
      : areaStatus === 'not_defined'
        ? 'setup'
        : null
    if (!kind) continue
    const owner = owners?.[area]
    if (canActOnSetup(owner, actor)) continue
    return { area, kind, owner: owner ?? 'workspace_admin' }
  }
  return null
}
