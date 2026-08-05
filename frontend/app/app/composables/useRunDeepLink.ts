/**
 * Boot-time replay of a RUN deep link: `?ws=<id>&block=<id>&run=<id>&view=<panel>`.
 *
 * The engine's PR verification report links each PR back into the run: to the observability
 * panel (Model activity / Provided context), and to the Tester's result window holding the
 * evidence its environment-lifecycle section lists. Both are built from the deployment's public
 * app URL. The SPA is a single canvas with no URL identity for anything, so this is the narrow
 * consumer that makes those links resolve: pin the board before the snapshot loads, then, once
 * the board is ready, select the task and open the panel for the run.
 *
 * Deliberately narrow. The GENERAL parser (every entity, every window, plus state→URL sync) is
 * slice 4 of `docs/initiatives/global-search-and-deep-links.md`; when it lands, this composable
 * is deleted rather than kept alongside it.
 */
import { watch } from 'vue'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'

/** The parsed link, or null when the URL carried none. */
interface PendingRunLink {
  workspaceId: string | null
  blockId: string | null
  runId: string
  view: string | null
}

const RUN_LINK_PARAMS = ['ws', 'block', 'run', 'view'] as const

/**
 * Read (and strip) a run deep link from the current URL. Called BEFORE `workspace.init()` so
 * the pinned board id is in place when `resolveActiveBoard` picks which board to open. The
 * params are removed from the URL — mirroring the `?invite=` / `?infraSetup=` handling — so a
 * reload doesn't re-open the panel and the link isn't left sitting in history.
 */
export function captureRunDeepLink(): PendingRunLink | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const runId = params.get('run')
  if (!runId) return null

  const link: PendingRunLink = {
    workspaceId: params.get('ws'),
    blockId: params.get('block'),
    runId,
    view: params.get('view'),
  }
  for (const key of RUN_LINK_PARAMS) params.delete(key)
  const qs = params.toString()
  history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  return link
}

/**
 * Capture a run deep link and, once the board has hydrated, apply it. Returns nothing; the
 * caller mounts it once, next to `workspace.init()`.
 *
 * Applying WAITS for `workspace.ready`: opening the panel against a half-loaded board would
 * read an execution the snapshot hasn't delivered yet. The watcher is one-shot — a later
 * refresh must not re-open a panel the user closed.
 */
export function useRunDeepLink(): void {
  const link = captureRunDeepLink()
  if (!link) return

  const workspace = useWorkspaceStore()
  const ui = useUiStore()

  // Pin the board the link names BEFORE init resolves the active one, so the run's own board
  // opens rather than whichever one was last used on this device.
  if (link.workspaceId) workspace.workspaceId = link.workspaceId

  // Applied at most once — a later refresh must not re-open a panel the user closed. The guard
  // is a flag rather than `{ once: true }` (which would burn the single run on the immediate
  // not-ready tick and never navigate) and `stop` is a `let` rather than a `const` (with
  // `immediate`, the callback runs synchronously BEFORE the binding initialises, so an
  // already-hydrated board would hit the temporal dead zone instead of navigating).
  let applied = false
  let stop: (() => void) | undefined
  stop = watch(
    () => workspace.ready,
    (ready) => {
      if (!ready || applied) return
      applied = true
      if (link.blockId) ui.select(link.blockId)
      // Three views are served: the run's outcome summary (the non-code answer to "what did this
      // change", and the one a link from outside the product should land on), the observability
      // panel, and the Tester's result window (where the screenshots the report's
      // environment-lifecycle section lists are rendered). An unknown view still lands the user on
      // the right board and task rather than failing the navigation.
      if (link.view === 'outcome') ui.openRunOutcome(link.runId)
      else if (link.view === 'observability') ui.openObservability(link.runId)
      else if (link.view === 'test-evidence') ui.openTestEvidence(link.runId)
      stop?.()
    },
    { immediate: true },
  )
}
