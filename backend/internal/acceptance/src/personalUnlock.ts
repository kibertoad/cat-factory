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

import { closeSync, openSync, writeSync } from 'node:fs'
import { ReadStream } from 'node:tty'
import { personalPasswordProblem } from '@cat-factory/contracts'
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
      password = checked(await readSecret(promptFor(reason)))
    },
  }
}

/** The question an operator reads, from the reason its caller gives, so both asks ask it once. */
function promptFor(reason: string): string {
  return `${reason}\nPersonal password: `
}

/**
 * An entered password, or a refusal naming what is wrong with it.
 *
 * The line terminator only, never `trim()`: a space is printable ASCII, so a leading or trailing one
 * is part of a legal password, and trimming would send a value the operator did not type and then
 * report the deployment's `wrong_password` as if they had mistyped.
 *
 * Checked against the platform's OWN rule (`personalPasswordProblem`), so a password this suite
 * accepts is one the deployment accepts. Locally rather than after a round trip, because a too-short
 * entry comes back as the same `wrong_password` as a wrong one, and the suite never re-prompts: the
 * operator would be told their password is wrong when what happened is that it was never long enough
 * to be one.
 */
function checked(entered: string): string {
  const value = entered.replace(/\r?\n$/, '')
  const problem = personalPasswordProblem(value)
  if (problem) throw new Error(`${problem} The run cannot be unlocked.`)
  return value
}

/**
 * Ask for the password and RETURN it: the up-front ask, for `acceptance/globalSetup.ts`.
 *
 * The one function here that hands the password out rather than sealing it in a closure, and it earns
 * that because of how vitest is shaped. Every spec file gets its OWN module graph even under one
 * worker, so a holder built in spec 01 cannot be reached from spec 02, and asking lazily is asking
 * once per FILE that starts or answers a run: four prompts a pass, each drawn over a live reporter
 * that is redrawing the same lines. `globalSetup` runs in the main process before any of that, asks
 * once, and hands the value to each worker over vitest's RPC channel.
 *
 * What that costs is honest and bounded: the password now sits in the main process's memory as well
 * as each worker's. What it does NOT cost is the property the design actually protects, which is that
 * no copy is ever written down: not the `.env`, not the ledger, not the journal, not a log line, and
 * not an environment variable a child process would inherit.
 */
export async function readPersonalPassword(reason: string): Promise<string> {
  return checked(await readSecretFromTty(promptFor(reason)))
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
 * The terminal to ask on: the process's CONTROLLING terminal, opened directly, with `process.stdin`
 * as the fallback when it happens to be one.
 *
 * `process.stdin` alone is not enough, and this is the whole reason this indirection exists. The
 * pass runs under vitest, whose worker processes are forked with PIPED stdio, so `stdin.isTTY` is
 * undefined there and a prompt built on it could never ask anything — the one path this feature
 * exists for would have thrown "stdin is not a terminal" at the first start, on every run, while a
 * terminal sat right there. Opening `/dev/tty` (`CONIN$` on Windows) is how every other password
 * prompt solves this, and it is STRONGER than the stdin check it replaces rather than weaker: a
 * controlling terminal cannot be fed from a pipe, a file or a shell variable at all, so the
 * "nothing persisted" property is now structural instead of a check.
 *
 * THROWS when there is no terminal to reach at all (CI, a daemon), or one that cannot be switched
 * to raw mode, naming what to do instead, and those are two different refusals because they need
 * two different actions. A nullable return would only move the same refusals to the one call site.
 * Raw mode is entered HERE rather than at the read, because being readable without echo is what this
 * function promises and opening the device does not establish it. And `close` is therefore the
 * symmetric undo, putting echo back before releasing the device it belongs to. See
 * {@link releaseTerminal} for the one rule that cleanup has to get right.
 */
function openTerminal(): { input: ReadStream; write: (text: string) => void; close: () => void } {
  const device = consoleDevice()
  const fd = tryOpen(device.path, device.flags)
  if (fd === null) {
    // No controlling terminal. THIS is where a console-less process (CI, a daemon, `nohup`, an
    // agent's detached background shell) lands: Windows answers `EBADF` for `CONIN$` when the
    // process has no console at all, exactly as POSIX answers `ENXIO` for `/dev/tty`.
    //
    // `process.stdin` is still worth trying, because a standalone CLI run straight from a shell
    // (`pnpm status`) has one even where `/dev/tty` is unavailable.
    if (!process.stdin.isTTY) throw noTerminal()
    const input = process.stdin as unknown as ReadStream
    // The process's OWN stdin: nothing here closes it, so releasing it is putting echo back and
    // letting go of the reader.
    const close = () => {
      restoreEcho(input)
      input.pause()
    }
    enterRawMode(input, close)
    return { input, write: (text) => process.stderr.write(text), close }
  }
  // Prompt down the same terminal where possible, so it cannot be swallowed by the test reporter
  // that owns this worker's stdout. Windows reads and writes the console through two different
  // devices; POSIX can write back down the one it read from.
  const outFd =
    process.platform === 'win32' ? tryOpen('\\\\.\\CONOUT$', 'w') : tryOpen(device.path, 'w')
  const input = new ReadStream(fd)
  const close = () => releaseTerminal(input, outFd)
  enterRawMode(input, close)
  return {
    input,
    write: (text) => {
      if (outFd === null) process.stderr.write(text)
      else writeSync(outFd, text)
    },
    close,
  }
}

/**
 * The device to read the password from, and the ACCESS to open it with.
 *
 * The flags are the whole point of this function existing. `SetConsoleMode` writes to the console
 * INPUT BUFFER, so it needs a handle carrying `GENERIC_WRITE`: opened read-only, `CONIN$` reads
 * perfectly well and refuses raw mode with `EPERM` on a machine that has a console right there.
 * That is the `setRawMode EPERM` this whole file was written around, and it was never evidence of a
 * missing console: it was this open. A console-less process cannot open `CONIN$` at all (`EBADF`),
 * which is why the no-terminal refusal belongs on the OPEN and never needed to move.
 *
 * POSIX stays read-only: `tcsetattr` needs no write access, and `/dev/tty` opened `r+` is a second
 * writable handle on a terminal this prompt already opens a separate one for.
 */
function consoleDevice(): { path: string; flags: string } {
  return process.platform === 'win32'
    ? { path: '\\\\.\\CONIN$', flags: 'r+' }
    : { path: '/dev/tty', flags: 'r' }
}

/**
 * Echo back on, and ONLY where this prompt is what turned it off.
 *
 * `close` runs on every exit path, including the one where entering raw mode is what failed and the
 * one where the device is already gone. `setRawMode` reports its failure by EMITTING on the stream,
 * which a stream with no `error` listener throws, so asking a device to leave a mode it never
 * entered would put a second failure on top of the one being reported.
 */
function restoreEcho(input: ReadStream): void {
  if (input.isRaw) input.setRawMode(false)
}

/**
 * Release what {@link openTerminal} established, in the reverse order.
 *
 * ONE rule, and it cost this file twice over: the descriptor a `ReadStream` is CONSTRUCTED with
 * belongs to the stream, so `input.destroy()` is that descriptor's close and a `closeSync(fd)` beside
 * it is not belt-and-braces but an `EBADF` thrown out of a cleanup. On the refusal path that came out
 * of the `catch` in {@link enterRawMode} and REPLACED the message naming the password and both ways
 * out, which is the only reason that path exists. On the ordinary path it came out of the `data`
 * handler at the instant the operator's password was accepted, so the promise never settled and a
 * prompt that had already succeeded hung. `outFd` has no such owner and is ours to close.
 *
 * `closeFd` is injected because a test cannot own a console to release, and this is the half of the
 * prompt that no platform lets a unit test drive for real.
 */
export function releaseTerminal(
  input: ReadStream,
  outFd: number | null,
  closeFd: (fd: number) => void = closeSync,
): void {
  restoreEcho(input)
  input.destroy()
  if (outFd !== null) closeFd(outFd)
}

/** Open a path, or `null` — used for the OPTIONAL half of the terminal (where to print the prompt). */
function tryOpen(path: string, flags: string): number | null {
  try {
    return openSync(path, flags)
  } catch {
    return null
  }
}

/**
 * Switch a terminal to raw mode, or refuse the way {@link openTerminal} promises to.
 *
 * Opening the device is not proof a password can be read from it WITHOUT ECHOING IT, and echoing it
 * is not an option: the point of the prompt is that the password reaches this process and no
 * scrollback. So a device that will not switch is refused rather than read from.
 *
 * NOT the missing-console refusal, and that distinction is the correction this function carries. It
 * used to throw `noTerminal()`, on the belief that a console-less Windows process opens `CONIN$`
 * happily and lands here; it does not, it cannot open the device at all. What actually produced the
 * `setRawMode EPERM` operators saw was {@link consoleDevice} opening the console read-only, from a
 * WebStorm terminal with a console right there, so "run the suite from an interactive shell" told
 * someone already sitting in one to do what they had done. A refusal that names the wrong cause is
 * worse than the errno it replaced, because it is believed.
 *
 * Exported for the test: a terminal that opens and then refuses raw mode cannot be produced from a
 * unit test on either platform, and the property worth pinning is that the refusal names THIS cause.
 */
export function enterRawMode(input: ReadStream, cleanup: () => void): void {
  try {
    input.setRawMode(true)
  } catch (error) {
    cleanup()
    throw noHiddenInput(error)
  }
}

/** The refusal when there is no usable terminal: what to do instead, and why not an env var. */
function noTerminal(): Error {
  return new Error(
    'This pass needs your personal password to unlock the subscription its model runs on, but ' +
      'this process has no terminal to ask on.\n' +
      '  Run the suite from an interactive shell. The password is deliberately not readable ' +
      'from a variable or a file: it is the second factor protecting the stored credential, ' +
      'and a copy on disk would defeat it.\n' +
      '  To run unattended instead, pin a preset whose model resolves to a provider API key.',
  )
}

/**
 * The refusal when the terminal IS there and will not stop echoing.
 *
 * Its own wording because its own action: nothing about how the pass was invoked is wrong, so the
 * two remedies `noTerminal` offers are both dead ends here. What is left is a terminal that emulates
 * a console without implementing its modes (an MSYS/mintty pty is the one to expect), and the way
 * out is a terminal that does, or the unattended route.
 */
function noHiddenInput(cause: unknown): Error {
  return new Error(
    'This pass needs your personal password to unlock the subscription its model runs on. It ' +
      'reached your terminal, but that terminal will not turn OFF echo, and the password is ' +
      'never typed where it can be read back.\n' +
      '  Run the pass from a terminal that implements console modes: Windows Terminal, ' +
      'PowerShell, cmd.exe or a JetBrains terminal all do; an MSYS/mintty window (Git Bash ' +
      'launched by its own shortcut) does not, and `winpty` in front of the command is that ' +
      'window’s fix.\n' +
      '  To run unattended instead, pin a preset whose model resolves to a provider API key.',
    { cause },
  )
}

/**
 * Read a secret from the terminal without echoing it.
 *
 * Raw mode read character by character rather than `readline`'s private `_writeToOutput` override:
 * the same effect through the documented API. See {@link openTerminal} for why the terminal is
 * opened rather than taken from `process.stdin`, and why it arrives already in raw mode.
 *
 * `finally`, because it arrives already in raw mode: the prompt is the first thing that can fail
 * afterwards (a revoked console handle, a closed pipe on the `process.stderr` fallback), and every
 * path out of here has to put echo back. Left to the read alone, a prompt that could not be printed
 * returned the operator to a shell that echoed nothing they typed, with the process gone and nothing
 * left to restore it.
 */
async function readSecretFromTty(prompt: string): Promise<string> {
  const terminal = openTerminal()
  try {
    return await readWithoutEcho(terminal, prompt)
  } finally {
    terminal.close()
  }
}

/** The read itself: character by character, ending on Enter or on the operator declining. */
function readWithoutEcho(
  terminal: { input: ReadStream; write: (text: string) => void },
  prompt: string,
): Promise<string> {
  const input = terminal.input
  terminal.write(prompt)
  input.resume()
  input.setEncoding('utf8')
  return new Promise<string>((resolve, reject) => {
    let value = ''
    const done = (settle: () => void) => {
      input.off('data', onData)
      // The newline the suppressed echo did not print. Here rather than beside `close`, so a prompt
      // that could not be WRITTEN reports that failure instead of a second one on top of it.
      terminal.write('\n')
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
