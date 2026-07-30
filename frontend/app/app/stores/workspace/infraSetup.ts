import { ref } from 'vue'
import { applyInfraSetupTransition, isInfraSetupHealthStatus } from '@cat-factory/contracts'
import type { InfraSetup, InfraSetupArea, InfraSetupStatus } from '~/types/domain'

// The workspace store's infra-setup slice: the per-area setup/health projection the setup banner
// renders, and the live `infraSetup` event patch the reachability watcher pushes into it. Its own
// collaborator rather than more lines in the store body, because it is the one slice with RULES
// (which prior state a probe verdict may overwrite, and what a recovery does to a dismissal) instead
// of a plain assign-from-snapshot.

/**
 * Create the infra-setup slice. `hydrate` takes the authoritative projection off a snapshot;
 * `patchInfraSetup` applies one live transition.
 */
export function createInfraSetupState() {
  /**
   * Per-area infrastructure-setup status (ephemeral environments / agent executor / binary
   * storage) from the snapshot, driving the infra-setup banner. Null on an older backend that
   * doesn't compute it (⇒ no banner).
   */
  const infraSetup = ref<InfraSetup | null>(null)
  /**
   * The failing probe's own operator-facing reason per area ("connect ECONNREFUSED …", "HTTP 401"),
   * from the live `infraSetup` event only — a refused connection reads very differently from a
   * rejected token, and it is the one thing on the banner that says WHY.
   *
   * Deliberately NOT on the snapshot: the reason varies between passes and the notification card is
   * content-deduped, so persisting it there would re-toast the inbox for the whole outage. The
   * consequence is that a reload mid-outage renders the banner with no reason line, which is honest
   * (this session never saw the probe) and is why the reason is an ADDITION to the copy rather than
   * a replacement for it.
   */
  const infraSetupDetails = ref<Partial<Record<InfraSetupArea, string>>>({})

  function hydrate(next: InfraSetup | null | undefined) {
    infraSetup.value = next ?? null
    // The reasons belong to the live pushes this session observed, so an authoritative snapshot
    // supersedes them: keeping one would caption a freshly-read status with a stale probe.
    infraSetupDetails.value = {}
  }

  /**
   * Patch ONE infra area's status from a live `infraSetup` event, so the setup banner appears (or
   * clears) the moment the reachability watcher notices rather than on the next snapshot load.
   *
   * A targeted upsert, deliberately not a `refresh()`: this is a one-field delta on a projection
   * the snapshot recomputes wholesale, and a coalesced full refresh here would pay the ~18-read
   * aggregate for it. A no-op before the first snapshot has landed — `hydrate` is about to set the
   * authoritative projection, which already carries the recorded outage.
   *
   * The write goes through contracts' `applyInfraSetupTransition`, the SAME rule the backend's
   * snapshot fold uses, so live and reloaded state cannot disagree: only a `configured` area may
   * become `unreachable`. Assigning unconditionally (as this once did) rendered a red "check that
   * the service is running" banner over a `not_applicable`/`not_defined` area, which then vanished
   * on the next reload — a banner that contradicts the projection is worse than a late one.
   *
   * Recovering an area also drops its OUTAGE session dismissal, so a health state re-nags when it
   * recurs (see `isInfraSetupHealthStatus`): without this, dismissing one outage would silence the
   * next one for the rest of the session.
   */
  function patchInfraSetup(area: InfraSetupArea, status: InfraSetupStatus, detail?: string) {
    const current = infraSetup.value
    if (!current) return
    const next = applyInfraSetupTransition(current, area, status)
    // Refused by the shared rule (the projection out-ranks this probe), so nothing about the area
    // changed and its reason must not be captioned onto a status it does not describe.
    if (next === current) return
    infraSetup.value = next
    infraSetupDetails.value = { ...infraSetupDetails.value, [area]: detail }
    // `useUiStore` is resolved through the auto-import at CALL time, as it was in the store body
    // this moved out of: the ui store is only needed on a recovery, and reaching for it lazily keeps
    // this slice constructible before pinia has that store (and stubbable in the store unit tests).
    if (!isInfraSetupHealthStatus(status)) useUiStore().clearInfraSetupSessionDismissal(area)
  }

  return { infraSetup, infraSetupDetails, hydrate, patchInfraSetup }
}
