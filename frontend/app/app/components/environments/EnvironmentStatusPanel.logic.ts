// Which of an environment's two prose channels the panel shows, extracted from
// `EnvironmentStatusPanel.vue` so the precedence can be asserted without mounting the panel (see
// `EnvironmentStatusPanel.logic.spec.ts`).
//
// The environment record carries two accounts of itself and they answer different questions.
// `lastError` is a recorded FAULT: the provider's verbatim cause, written on a status the
// environment will not leave. `statusNote` is the provider's account of a state it has NOT left
// yet: why this environment is not ready. A row can carry both, and which one a reader is shown
// decides which layer they go looking at.

import type { RunEnvironment } from '~/types/execution'
import type { EnvironmentStatus } from '@cat-factory/contracts'

/**
 * The statuses whose failure block the panel renders: a fault is shown as the headline account
 * only where the environment actually stopped at one.
 */
const FAILURE_STATUSES = new Set<EnvironmentStatus>(['failed', 'expired'])

/**
 * The statuses a note still says something about. `ready` has REACHED the state the note explains
 * not being in, and the two teardown statuses describe a spin-up nobody is waiting on any more (a
 * teardown carries the row's note forward, so this is a live shape rather than a hypothetical
 * one). On `failed` / `expired` the note is what a provider that recorded no fault last said,
 * which is the disposition kernel's readiness verdict takes for the same pair.
 */
const NOTE_STATUSES = new Set<EnvironmentStatus>(['provisioning', 'failed', 'expired'])

/** Whether the verbatim provider error is the panel's account of this environment. */
export function showsProviderFailure(env: RunEnvironment | null | undefined): boolean {
  return !!env?.lastError && FAILURE_STATUSES.has(env.status)
}

/**
 * The note to render, or null.
 *
 * Two rules, and it is the FAULT's presence that decides the first rather than whether the error
 * block happens to be on screen. A recorded `lastError` outranks a note wherever they collide,
 * whatever the status: they are two claims about one environment and the fault is the more
 * specific one, so keying this off the error block's own render condition hid a real fault on
 * every status that block does not cover. And a status that has left the state the note describes
 * has nothing left to add with it.
 */
export function readStatusNote(env: RunEnvironment | null | undefined): string | null {
  if (!env || env.lastError) return null
  if (!NOTE_STATUSES.has(env.status)) return null
  return env.statusNote?.trim() || null
}
