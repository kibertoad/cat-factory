import type {
  ModelPresetRepository,
  RiskPolicyRepository,
  WorkspaceRiskPolicyReader,
} from '@cat-factory/kernel'
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
 * That emptiness question is asked of the tier that gets SEEDED, which since ADR 0055 is no longer
 * the whole of what a risk-policy read answers: a board's library is its own rows merged with the
 * account policies it inherits, so one account policy made the merged list non-empty and the catalog
 * fallback stopped applying — refusing a valid built-in id on exactly the unseeded boards the
 * fallback exists for.
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
  /**
   * The tier the catalog is lazily seeded INTO, when that is narrower than what `read` answers.
   * Absent ⇒ the two are the same, which is the model-preset case. Consulted only on a miss, so the
   * common path (a pin the library holds) still costs exactly one query.
   */
  seededTier?: (workspaceId: string) => Promise<{ id: string }[]>
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
  if (stored.some((row) => row.id === spec.pinned)) return
  // A miss is only a refusal once the SEEDED tier is known to hold something: while it is empty the
  // catalog is what the next read will write into it, so a built-in id names a policy that exists in
  // every sense the caller can observe.
  const seeded = spec.seededTier ? await spec.seededTier(spec.workspaceId) : stored
  if (seeded.length === 0 && spec.catalog().some((row) => row.id === spec.pinned)) return
  // The available ids are deliberately NOT listed back. Both libraries are readable at `admin` and
  // pinnable at `write`, so a refusal that enumerated them would hand the lower rung, by typo,
  // exactly what the higher one gates.
  throw new ValidationError(`No ${spec.singular} '${spec.pinned}' in this workspace.`, {
    reason: spec.notFoundReason,
  })
}

export function createPresetPinGuard(deps: {
  modelPresetRepository?: ModelPresetRepository
  /**
   * The board's merged risk-policy library (ADR 0055), so a task may pin a policy its ACCOUNT
   * defines. Reading the workspace tier alone here would refuse exactly the ids the picker offers.
   */
  riskPolicyReader?: WorkspaceRiskPolicyReader
  /**
   * The board's OWN tier, for the lazy-seeding question alone (`seededTier` below). Beside the
   * merged reader rather than instead of it: what a pin may NAME is the merged library, but what the
   * built-in catalog is about to be written into is only ever this one.
   */
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
          read: deps.riskPolicyReader?.list.bind(deps.riskPolicyReader),
          seededTier: deps.riskPolicyRepository?.list.bind(deps.riskPolicyRepository),
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
