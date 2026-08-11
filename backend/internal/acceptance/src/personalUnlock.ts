// Unlocking the operator's PERSONAL subscription for a headless pass.
//
// A pass pinned to a preset whose model is an individual-usage vendor (Claude / Codex / GLM) runs
// on the operator's OWN subscription, and the platform can only open that credential with their
// personal password. So the suite asks for it, once, at the moment a call actually needs it.
//
// **It is held in this process's memory and nowhere else.** Not in `.env`, not in the ledger, not
// in the journal, not in a log line. That is the whole point of the personal-password layer: the
// deployment stores the credential double-encrypted precisely so that possessing the database (or
// this machine's `.env`) is not enough to open it, and a suite that wrote the password beside the
// API key would hand both halves to anyone who read one file. A resumed pass asks again, which is
// the correct cost.
//
// The header rides EVERY request the client makes once a password is held, rather than being
// attached at the one call that first needed it: a pass answers parked decisions for hours after
// the start, each of those wakes the durable driver and re-mints the run's activation, and each
// therefore needs the password again. The server never keeps it between calls.

import { CatFactoryCredentialRequiredError } from '@cat-factory/sdk'

/** The header the platform reads the personal password from (`PERSONAL_PASSWORD_HEADER`). */
const PERSONAL_PASSWORD_HEADER = 'X-Personal-Password'

/**
 * A vendor named by the platform's refusal, for the prompt. `details` is `{ vendor, reason }` on a
 * `credential_required`, but this reads it defensively: the prompt has to work even if a future
 * deployment omits the field, and the ONE thing it must never do is fail while asking for the
 * password that would have fixed the run.
 */
function vendorOf(error: CatFactoryCredentialRequiredError): string | null {
  const details = error.details
  if (typeof details !== 'object' || details === null || !('vendor' in details)) return null
  const vendor = (details as { vendor?: unknown }).vendor
  return typeof vendor === 'string' && vendor ? vendor : null
}

/** Printable ASCII only, matching what the platform accepts: an HTTP header value is Latin-1. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

export interface PersonalUnlock {
  /** The header to merge into a request, or nothing while no password is held. */
  headers(): Record<string, string>
  /** Ask for the password (once per pass), naming why. Rejects when there is no terminal to ask. */
  obtain(reason: string): Promise<void>
  /** Whether a password has already been supplied this pass. */
  held(): boolean
}

/**
 * Build the holder. The password lives in this closure; nothing returns it, so the only way out is
 * the request header — which is what keeps "held in memory only" a property of the code rather
 * than a rule someone has to remember at each call site.
 */
export function createPersonalUnlock(
  readSecret: (prompt: string) => Promise<string> = readSecretFromTty,
): PersonalUnlock {
  let password: string | undefined
  return {
    headers: (): Record<string, string> =>
      password ? { [PERSONAL_PASSWORD_HEADER]: password } : {},
    held: () => password !== undefined,
    async obtain(reason) {
      const entered = (await readSecret(`${reason}\nPersonal password: `)).trim()
      if (!entered) {
        throw new Error('No personal password entered, so the run cannot be unlocked.')
      }
      if (!PRINTABLE_ASCII.test(entered)) {
        throw new Error(
          'A personal password must be printable ASCII (it travels as an HTTP header, which is ' +
            'Latin-1). This one is not, so the deployment would refuse it.',
        )
      }
      password = entered
    },
  }
}

/**
 * Run a call that may need the personal subscription, asking for the password if the deployment
 * says one is needed, then retrying ONCE.
 *
 * Lazy rather than up-front, and that is what keeps the common pass friction-free: a workspace
 * running on a provider API key never sees a prompt, because no call ever answers `428`. It also
 * means the suite never has to predict whether the pinned preset resolves to an individual-usage
 * vendor — the deployment already answers that question, precisely, at the moment it matters.
 *
 * Exactly one retry. A second `428` means the password was wrong or the subscription is not there,
 * and re-asking in a loop would turn a clear failure into a pass that hangs on a prompt nobody is
 * watching.
 */
export async function withPersonalUnlock<T>(
  unlock: PersonalUnlock,
  what: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (!(error instanceof CatFactoryCredentialRequiredError)) throw error
    // Already holding one and still refused: asking again would only re-collect the password that
    // just failed. This branch also catches the LATER call sites of a pass whose first unlock
    // worked and whose subscription has since lapsed, where there was never a prompt to repeat.
    if (unlock.held()) throw stillLocked(what, error)
    await unlock.obtain(
      `${what} runs on your personal ${vendorOf(error) ?? 'subscription'}, which only your ` +
        `personal password can open. It is used for this pass only and is never written anywhere.`,
    )
    try {
      return await call()
    } catch (retryError) {
      if (!(retryError instanceof CatFactoryCredentialRequiredError)) throw retryError
      throw stillLocked(what, retryError)
    }
  }
}

/**
 * The refusal that survives a supplied password: a wrong one, or a vendor this account has not
 * connected at all. Stated as its own message rather than re-thrown, because the raw `428` reads
 * as "you were not asked yet" to whoever finds it in the log an hour later.
 */
function stillLocked(what: string, error: CatFactoryCredentialRequiredError): Error {
  const vendor = vendorOf(error)
  return new Error(
    `${what} still needs a personal-credential unlock after the password was supplied` +
      `${vendor ? ` (vendor '${vendor}')` : ''}: ${error.message}\n` +
      `  Either the password is wrong, or this account has no ${vendor ?? 'subscription'} ` +
      `connected. Connect it under Model providers in the app and run the pass again.`,
    { cause: error },
  )
}

/**
 * Read a secret from the terminal without echoing it.
 *
 * Raw mode read character by character rather than `readline`'s private `_writeToOutput` override:
 * the same effect through the documented API. A non-TTY stdin REFUSES rather than reading the
 * password from a pipe, because a piped password is one that came from a file or a shell history
 * — exactly the persistence this whole path exists to avoid.
 */
async function readSecretFromTty(prompt: string): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) {
    throw new Error(
      'This pass needs your personal password to unlock the subscription its model runs on, but ' +
        'stdin is not a terminal so there is nothing to ask.\n' +
        '  Run the suite from an interactive shell. The password is deliberately not readable ' +
        'from a variable or a file: it is the second factor protecting the stored credential, ' +
        'and a copy on disk would defeat it.\n' +
        '  To run unattended instead, pin a preset whose model resolves to a provider API key.',
    )
  }
  process.stdout.write(prompt)
  input.setRawMode(true)
  input.resume()
  input.setEncoding('utf8')
  return new Promise<string>((resolve, reject) => {
    let value = ''
    const done = (settle: () => void) => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      process.stdout.write('\n')
      settle()
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value))
        // Ctrl-C / Ctrl-D: the operator declining. Reported as a refusal rather than silently
        // returning an empty password, which would fail one call later wearing the wrong face.
        if (ch === '\u0003' || ch === '\u0004') {
          return done(() => reject(new Error('Cancelled at the personal-password prompt.')))
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    input.on('data', onData)
  })
}
