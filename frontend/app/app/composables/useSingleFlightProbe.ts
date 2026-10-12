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
 *
 * Only a run that RESOLVES settles the board. A rejected run leaves it unprobed, so the next
 * `ensureProbed` asks again rather than treating a failed read as an answer.
 *
 * Two more cases serve callers that changed the state themselves:
 *
 *   - `probe({ afterWrite: true })` always starts a new run, even with one in flight. A reload
 *     after a write must not ride a run that started before the write, or it returns the state the
 *     write replaced. A concurrent `ensureProbed` rides the newest run.
 *   - {@link invalidate} forgets that the board is probed, for state cleared outside a run (a
 *     reset or a disconnect), so the next `ensureProbed` reads it again.
 */
interface ProbeOptions {
  /**
   * The caller just changed what the run reads, so a run already in flight is too old to share.
   * Defaults to false: a burst of callers on one board open shares the run in flight.
   */
  afterWrite?: boolean
}

interface SingleFlightProbe {
  probe: (options?: ProbeOptions) => Promise<void>
  ensureProbed: () => Promise<void>
  invalidate: () => void
}

export function useSingleFlightProbe(
  run: () => Promise<void>,
  currentId: () => string | null,
): SingleFlightProbe {
  let inFlight: Promise<void> | null = null
  let inFlightId: string | null = null
  let probedId: string | null = null

  function start(id: string | null): Promise<void> {
    // Only record the outcome / clear the in-flight slot when a NEWER probe hasn't superseded us.
    // Otherwise an out-of-order completion (an older probe for board A resolving after a newer
    // probe for board B) would stamp probedId back to A and force a redundant re-probe of B on the
    // next ensureProbed. The newer probe owns `inFlight`, so it records the board that's actually
    // current.
    const p: Promise<void> = Promise.resolve(run())
      .then(
        () => {
          if (inFlight === p) probedId = id
        },
        (error: unknown) => {
          if (inFlight === p) probedId = null
          throw error
        },
      )
      .finally(() => {
        if (inFlight === p) {
          inFlight = null
          inFlightId = null
        }
      })
    inFlight = p
    inFlightId = id
    return p
  }

  function probe(options: ProbeOptions = {}): Promise<void> {
    const id = currentId()
    // Share an already-running probe for the same board (the concurrent-burst case), unless the
    // caller wrote since it started. Otherwise start a fresh one: a deliberate refresh must always
    // re-read.
    if (!options.afterWrite && inFlight && inFlightId === id) return inFlight
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

  function invalidate(): void {
    // Drop the in-flight slot too: a run that started before the state was cleared must not stamp
    // the board as probed when it lands.
    probedId = null
    inFlight = null
    inFlightId = null
  }

  return { probe, ensureProbed, invalidate }
}
