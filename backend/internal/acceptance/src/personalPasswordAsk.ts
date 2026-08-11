// The ONE up-front personal-password ask: what it decides, and what it does when it cannot.
//
// `acceptance/globalSetup.ts` is the wiring; every judgement is here, because every judgement it
// makes is a DEGRADATION, and a degradation nothing tests is a degradation that quietly becomes an
// abort. This hook runs before the first prerequisite has been evaluated and before a single journal
// line has been written, so anything it throws is the operator's WHOLE output: no "your key names a
// different workspace", no "the pinned preset's model is unwired", no ledger, no journal. The
// preflight owns diagnosing a deployment, and it cannot own it from behind a hook that refused first.
//
// So: three things can go wrong here, and two of them answer the same way. A deployment that cannot
// be read and a terminal that cannot be asked on both leave the ask exactly where it lived before
// anything asked early, at the first dispatch that needs one, with the preflight's findings already
// on screen. The third is not a degradation at all: an operator pressing Ctrl-C is a person saying
// "not this pass", and a pass that started anyway would spend an afternoon on a refusal.

import { describeThrown, scrubbed } from './operatorText.ts'
import { needsPersonalPassword, type PinnedPreset } from './presets.ts'
import { PersonalPasswordDeclined } from './personalUnlock.ts'

/** Everything this decision touches, so the whole of it is drivable from a unit test. */
export type PersonalPasswordAskDeps = {
  /** The pinned preset with its catalog row. THROWS when the deployment could not be read. */
  readPinned: () => Promise<PinnedPreset | null>
  /** Ask the operator, naming why. Rejects when there is no terminal to ask on. */
  readSecret: (reason: string) => Promise<string>
  /** Hand the password to every worker, for the pass that is about to start. */
  provide: (password: string) => void
  /** What the operator reads while this happens. */
  log: (message: string) => void
}

/**
 * Ask once, or say why it did not.
 *
 * Rejects for exactly one cause: {@link PersonalPasswordDeclined}. Everything else it can meet is
 * reported and returned from, which is what keeps this hook incapable of ending a pass that the
 * preflight has not yet had a chance to describe.
 */
export async function askForPersonalPassword(deps: PersonalPasswordAskDeps): Promise<void> {
  const pinned = await readPinned(deps)
  if (!pinned || !needsPersonalPassword(pinned.model)) return
  const password = await ask(deps, promptReason(pinned))
  if (password !== null) deps.provide(password)
}

/**
 * The pinned pair, or `null` with the reason stated.
 *
 * Two different absences reach the same answer and both are worth the same message: the deployment
 * could not be reached at all (an incomplete `.env`, a wrong key, nothing listening), or it answered
 * and the pinned preset is not in the library. Neither is this hook's to diagnose, and the second is
 * a REQUIRED prerequisite with a menu and a remedy behind it.
 */
async function readPinned(deps: PersonalPasswordAskDeps): Promise<PinnedPreset | null> {
  try {
    const pinned = await deps.readPinned()
    if (pinned) return pinned
  } catch (error) {
    deps.log(`\nCould not read the pinned model preset: ${describeThrown(error)}`)
  }
  deps.log(
    '\nCould not tell yet whether this pass needs your personal password, so it was not asked ' +
      'for up front. The preflight reports what it finds; if a run does need one, the prompt ' +
      'comes at that first dispatch instead.',
  )
  return null
}

/**
 * The password, or `null` with the refusal stated and the pass left to continue.
 *
 * The refusal is printed rather than thrown, and what it costs is one prompt drawn over the reporter
 * later instead of one drawn cleanly now. What throwing cost was the entire preflight: a pass in an
 * MSYS window, a container without a tty, or an agent's detached shell ended here with a message
 * about console modes and nothing about the deployment it never reached.
 *
 * A DECLINED prompt is re-thrown, because it is the one answer that is a person's decision rather
 * than a limit of where the pass is running.
 */
async function ask(deps: PersonalPasswordAskDeps, reason: string): Promise<string | null> {
  try {
    return await deps.readSecret(reason)
  } catch (error) {
    if (error instanceof PersonalPasswordDeclined) throw error
    deps.log(
      `\n${describeThrown(error)}\n` +
        '\nThe pass continues from here: the prerequisites run first, and if a dispatch does need ' +
        'the password, the same ask (or this same refusal) arrives there, after everything the ' +
        'preflight found has been printed.',
    )
    return null
  }
}

/**
 * What the operator is being asked for, and on whose behalf.
 *
 * Scrubbed like every other value this suite renders for a person: the preset name is typed by
 * whoever configured the workspace and the model label comes back from the deployment, so both are
 * strings this process did not write, printed to a console, one line above a password prompt.
 */
function promptReason(pinned: PinnedPreset): string {
  return (
    `This pass runs '${scrubbed(pinned.preset.name)}' on ${scrubbed(pinned.model.label)}, which ` +
    `is your personal ${scrubbed(pinned.model.provider)} subscription: only your personal ` +
    'password can open it. It is used for this pass only, is held in memory, and is written nowhere.'
  )
}
