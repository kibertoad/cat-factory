import type { ModelPresetRepository, RiskPolicyRepository } from '@cat-factory/kernel'
import {
  seedModelPresets,
  seedRiskPolicies,
  UnavailableError,
  ValidationError,
} from '@cat-factory/kernel'

/**
 * Refuse a task that PINS a library id nothing in the workspace carries.
 *
 * A block's `modelPresetId` and `riskPolicyId` both mean "the workspace default" when ABSENT, and
 * the run path resolves a DANGLING id to that same default rather than failing. So a typo is
 * accepted, the run succeeds, and nothing anyone can read afterwards separates the task that ran
 * on the model it named from the task that ran on whatever the workspace default happened to be
 * that day. That is the failure a pinned id exists to prevent, and the one it invites: the id is a
 * string somebody pasted.
 *
 * **On the service rather than at a route**, beside `riskPolicySelectionGuard.ts`, because
 * `addTask` and `updateBlock` are reached by the SPA, the internal API, the public API, tracker
 * intake, an initiative spawn and blueprint reconciliation. A check at one door is a special case
 * that leaves every other door falling back silently, and the doors with nobody watching are where
 * a run about the wrong thing goes unnoticed longest.
 *
 * **What counts as EXISTING on a workspace whose library was never read.** Both libraries are
 * lazily materialised: `ModelPresetService.list` / `RiskPolicyService.list` write the built-in
 * catalog on first use, and only when the stored library is EMPTY. Reading rows alone would
 * therefore refuse a perfectly good built-in id on a fresh workspace, so an empty library is read
 * as the catalog it is about to become. Which also keeps this a pure READ: seeding here would be a
 * write performed in order to say no.
 *
 * A repository the facade never wired is a different answer again, and a `503` rather than a
 * `422`: "no such policy" is true and useless when the library holds nothing at all and the fix is
 * to wire a module. It fires only for a caller that pinned something, since pinning nothing has no
 * dependency on the module being there.
 */
export interface PresetPinGuard {
  /**
   * Throw when either pinned id names nothing in `homeWorkspaceId`'s libraries.
   *
   * `homeWorkspaceId` is the workspace the row LIVES in, never the acting board, for the reason
   * the selection guard takes one: a task in a mounted foreign service resolves its ids against
   * that service's home library, so asking here about the acting board would answer about the
   * wrong shelf. Both ids are the RAW values, where `undefined`, `null` and `''` alike mean "the
   * workspace default" and so can miss nothing.
   */
  assertPinsExist(input: {
    homeWorkspaceId: string
    modelPresetId?: string | null
    riskPolicyId?: string | null
  }): Promise<void>
}

/** One knob's worth of the check: everything that differs between the two libraries. */
interface PinnedLibrary {
  pinned: string | null | undefined
  workspaceId: string
  /** Absent ⇒ the facade wired no such repository. */
  read?: (workspaceId: string) => Promise<{ id: string }[]>
  /** What a never-read library is about to hold, so an unseeded workspace is not a refusal. */
  catalog: () => readonly { id: string }[]
  /** The noun a person reads, and the two `details.reason` values a client branches on. */
  singular: string
  plural: string
  notFoundReason: string
  unwiredReason: string
}

async function assertPinned(spec: PinnedLibrary): Promise<void> {
  if (!spec.pinned) return
  if (!spec.read) {
    throw new UnavailableError(`${spec.plural} are not configured`, spec.unwiredReason)
  }
  const stored = await spec.read(spec.workspaceId)
  const library = stored.length > 0 ? stored : spec.catalog()
  if (library.some((row) => row.id === spec.pinned)) return
  // The available ids are deliberately NOT listed back. Both libraries are readable at `admin` and
  // pinnable at `write`, so a refusal that enumerated them would hand the lower rung, by typo,
  // exactly what the higher one gates.
  throw new ValidationError(`No ${spec.singular} '${spec.pinned}' in this workspace.`, {
    reason: spec.notFoundReason,
  })
}

export function createPresetPinGuard(deps: {
  modelPresetRepository?: ModelPresetRepository
  riskPolicyRepository?: RiskPolicyRepository
}): PresetPinGuard {
  return {
    async assertPinsExist({ homeWorkspaceId, modelPresetId, riskPolicyId }) {
      // Two independent questions against two tables, asked together: a task pinning both would
      // otherwise pay two sequential round trips to refuse on the first.
      await Promise.all([
        assertPinned({
          pinned: modelPresetId,
          workspaceId: homeWorkspaceId,
          read: deps.modelPresetRepository?.list.bind(deps.modelPresetRepository),
          catalog: seedModelPresets,
          singular: 'model preset',
          plural: 'Model presets',
          notFoundReason: 'model_preset_not_found',
          unwiredReason: 'model_presets_unwired',
        }),
        assertPinned({
          pinned: riskPolicyId,
          workspaceId: homeWorkspaceId,
          read: deps.riskPolicyRepository?.list.bind(deps.riskPolicyRepository),
          catalog: seedRiskPolicies,
          singular: 'risk policy',
          plural: 'Risk policies',
          notFoundReason: 'risk_policy_not_found',
          unwiredReason: 'risk_policies_unwired',
        }),
      ])
    },
  }
}
