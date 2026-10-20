/**
 * Boot-time replay of a RUN deep link: `?ws=<id>&block=<id>&run=<id>&view=<panel>`.
 *
 * The task the link names is brought into view (`useTaskReveal`), and `view` picks what opens on
 * it: `run` (also what a link with no `view` gets) opens the task's focus view, where its pipeline
 * is followed step by step; `outcome`, `observability` and `test-evidence` open those result
 * windows for the run. An unknown view still lands on the right board and task.
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
import { useTaskReveal } from './useTaskReveal'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'

/** The parsed link, or null when the URL carried none. */
export interface PendingRunLink {
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

/** The view a link with no `view` opens: the task's running pipeline. */
export const RUN_LINK_DEFAULT_VIEW = 'run'

/** What applying a run link can do, so which link opens what is testable without a board. */
export interface RunLinkSurfaces {
  revealTask: (blockId: string) => void
  /** The task's focus view, with the pipeline of its current run. */
  openRun: (blockId: string) => void
  openOutcome: (runId: string, blockId: string | null) => void
  openObservability: (runId: string) => void
  openTestEvidence: (runId: string) => void
}

/** Apply a captured link to a hydrated board: the task brought into view, then its view. */
export function applyRunDeepLink(link: PendingRunLink, surfaces: RunLinkSurfaces): void {
  if (link.blockId) surfaces.revealTask(link.blockId)
  switch (link.view ?? RUN_LINK_DEFAULT_VIEW) {
    case 'run':
      if (link.blockId) surfaces.openRun(link.blockId)
      break
    // `outcome` is passed the block as well as the run: it is the one view that stays readable on
    // a task whose run the snapshot no longer carries, which a link followed weeks later is.
    case 'outcome':
      surfaces.openOutcome(link.runId, link.blockId)
      break
    case 'observability':
      surfaces.openObservability(link.runId)
      break
    case 'test-evidence':
      surfaces.openTestEvidence(link.runId)
      break
    default:
      break
  }
}

/**
 * Capture a run deep link and, once the board has hydrated, apply it. Returns nothing; the
 * caller mounts it once, next to `workspace.init()`.
 *
 * Applying WAITS for `workspace.ready`: opening the panel against a half-loaded board would
 * read an execution the snapshot hasn't delivered yet, and the camera waits further, for the
 * canvas to have drawn the frame it centres on. The watcher is one-shot: a later refresh must
 * not re-open a panel the user closed.
 */
export function useRunDeepLink(): void {
  const link = captureRunDeepLink()
  if (!link) return

  const workspace = useWorkspaceStore()
  const ui = useUiStore()
  const { revealTask } = useTaskReveal()

  // Pin the board the link names BEFORE init resolves the active one, so the run's own board
  // opens rather than whichever one was last used on this device.
  if (link.workspaceId) workspace.workspaceId = link.workspaceId

  // Applied at most once. The guard is a flag rather than `{ once: true }` (which would burn the
  // single run on the immediate not-ready tick and never navigate) and `stop` is a `let` rather
  // than a `const` (with `immediate`, the callback runs synchronously BEFORE the binding
  // initialises, so an already-hydrated board would hit the temporal dead zone instead of
  // navigating).
  let applied = false
  let stop: (() => void) | undefined
  stop = watch(
    () => workspace.ready,
    (ready) => {
      if (!ready || applied) return
      applied = true
      applyRunDeepLink(link, {
        revealTask,
        openRun: (blockId) => ui.focus(blockId),
        openOutcome: (runId, blockId) => ui.openRunOutcome(runId, blockId),
        openObservability: (runId) => ui.openObservability(runId),
        openTestEvidence: (runId) => ui.openTestEvidence(runId),
      })
      stop?.()
    },
    { immediate: true },
  )
}
