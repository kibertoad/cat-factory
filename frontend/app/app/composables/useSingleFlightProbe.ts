/**
 * Single-flight guard for a per-workspace integration probe (app-startup initiative, item 12).
 *
 * On a board open the same probe is fired from several places at once — e.g. `github.probe()` runs
 * from both the board page (to resolve the onboarding gate) and the SideBar, and the SideBar fans
 * out five more (`documents` / `tasks` / `slack` / `library` / provider connections). Each was an
 * independent network call, and a re-mount re-ran them. This wraps a store's probe with two
 * behaviours keyed on the active workspace id:
 *
 *   - {@link probe} — always re-runs the probe (deliberate refresh, e.g. after a connect), but a
 *     burst of concurrent callers on ONE board open shares the single in-flight request.
 *   - {@link ensureProbed} — runs the probe AT MOST ONCE per workspace: a no-op when this board is
 *     already probed, or the shared in-flight promise otherwise. This is what the on-board-open
 *     fan-out uses, so the duplicate/refire collapses to one call — while a workspace SWITCH (a new
 *     id) still re-probes, since connections are per board.
 *
 * The id-keying means no explicit reset on workspace change: a call for a different id than the last
 * completed probe re-runs. `run` reads whatever workspace-scoped state it needs itself; `currentId`
 * only supplies the key (and the "which board did this settle for" record).
 */
interface SingleFlightProbe {
  probe: () => Promise<void>
  ensureProbed: () => Promise<void>
}

export function useSingleFlightProbe(
  run: () => Promise<void>,
  currentId: () => string | null,
): SingleFlightProbe {
  let inFlight: Promise<void> | null = null
  let inFlightId: string | null = null
  let probedId: string | null = null

  function start(id: string | null): Promise<void> {
    const p = Promise.resolve(run()).finally(() => {
      probedId = id
      if (inFlight === p) {
        inFlight = null
        inFlightId = null
      }
    })
    inFlight = p
    inFlightId = id
    return p
  }

  function probe(): Promise<void> {
    const id = currentId()
    // Share an already-running probe for the same board (the concurrent-burst case); otherwise
    // start a fresh one — a deliberate refresh must always re-read.
    if (inFlight && inFlightId === id) return inFlight
    return start(id)
  }

  function ensureProbed(): Promise<void> {
    const id = currentId()
    // Already settled for this board and nothing running → nothing to do.
    if (probedId === id && !inFlight) return Promise.resolve()
    // A probe for this board is in flight → ride it rather than firing a duplicate.
    if (inFlight && inFlightId === id) return inFlight
    return start(id)
  }

  return { probe, ensureProbed }
}
