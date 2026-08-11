import type { ReadStream } from 'node:tty'
import { CatFactoryCredentialRequiredError, CatFactoryConflictError } from '@cat-factory/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  createPersonalUnlock,
  enterRawMode,
  PersonalPasswordDeclined,
  readWithoutEcho,
  releaseTerminal,
  withPersonalUnlock,
} from '../src/personalUnlock.ts'

// The unlock exists so a pass can run on the operator's OWN subscription without the password
// living anywhere but this process. What is worth pinning is therefore not the prompt's cosmetics
// but the three properties an operator relies on: it is asked for only when a call actually needs
// it, it then rides EVERY later request, and a wrong password fails once and loudly rather than
// re-prompting forever at a terminal nobody is watching.

const credentialRequired = (vendor?: string) =>
  new CatFactoryCredentialRequiredError({
    status: 428,
    code: 'credential_required',
    message: 'Enter your personal password to run this claude model.',
    ...(vendor ? { details: { vendor, reason: 'password_required' } } : {}),
    requestId: 'req_1',
    body: null,
  })

describe('createPersonalUnlock', () => {
  it('sends no header until a password is supplied', async () => {
    const unlock = createPersonalUnlock(async () => 'hunter2')
    expect(unlock.headers()).toEqual({})
    expect(unlock.held()).toBe(false)

    await unlock.obtain('because')
    expect(unlock.headers()).toEqual({ 'X-Personal-Password': 'hunter2' })
    expect(unlock.held()).toBe(true)
  })

  it('refuses a password the deployment could not carry in a header', async () => {
    // Header values are Latin-1, so the platform restricts the password to printable ASCII.
    // Catching it here names the real problem; sending it produces a transport-level failure
    // several layers from anything that mentions passwords.
    const unlock = createPersonalUnlock(async () => 'påssword')
    await expect(unlock.obtain('because')).rejects.toThrow(/printable ASCII/)
    expect(unlock.held()).toBe(false)
  })

  it('refuses an empty answer rather than sending a blank password', async () => {
    const unlock = createPersonalUnlock(async () => '')
    await expect(unlock.obtain('because')).rejects.toThrow(/No password entered/)
  })

  it('refuses one shorter than the platform accepts, before spending a round trip on it', async () => {
    // The deployment answers a too-short password with the same `wrong_password` as an incorrect
    // one, and the suite never re-prompts — so without this the operator is told their password is
    // wrong when what happened is that it was never long enough to be one.
    const unlock = createPersonalUnlock(async () => 'short')
    await expect(unlock.obtain('because')).rejects.toThrow(/at least 6 characters/)
    expect(unlock.held()).toBe(false)
  })

  it('keeps a password the operator typed with surrounding spaces intact', async () => {
    // A space is printable ASCII, so `personalPasswordSchema` accepts one at either end and a
    // stored password may genuinely have it. Trimming sent a DIFFERENT password than the one typed
    // and reported the deployment's refusal as if the operator had mistyped it.
    const unlock = createPersonalUnlock(async () => ' hunter2 ')
    await unlock.obtain('because')
    expect(unlock.headers()).toEqual({ 'X-Personal-Password': ' hunter2 ' })
  })

  it('drops only the line terminator a piped answer carries', async () => {
    const unlock = createPersonalUnlock(async () => 'hunter2\n')
    await unlock.obtain('because')
    expect(unlock.headers()).toEqual({ 'X-Personal-Password': 'hunter2' })
  })
})

describe('withPersonalUnlock', () => {
  it('asks for nothing when the call succeeds', async () => {
    const readSecret = vi.fn(async (_prompt: string) => 'hunter2')
    const unlock = createPersonalUnlock(readSecret)
    await expect(withPersonalUnlock(unlock, 'Starting', async () => 'ok')).resolves.toBe('ok')
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('prompts on a 428 and retries the call once', async () => {
    const readSecret = vi.fn(async (_prompt: string) => 'hunter2')
    const unlock = createPersonalUnlock(readSecret)
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(credentialRequired('claude'))
      .mockResolvedValueOnce('started')

    await expect(withPersonalUnlock(unlock, 'Starting the scaffold', call)).resolves.toBe('started')
    expect(call).toHaveBeenCalledTimes(2)
    // The vendor the deployment named reaches the prompt: "your personal claude subscription" is
    // what tells an operator WHICH password is being asked for.
    expect(readSecret.mock.calls[0]?.[0]).toContain('claude')
    expect(unlock.headers()).toEqual({ 'X-Personal-Password': 'hunter2' })
  })

  it('gives up after one retry rather than re-prompting a terminal nobody is watching', async () => {
    // Long enough to be a legal password, so what is under test is the retry budget rather than
    // the local length check (which would refuse a 5-character one before any call).
    const readSecret = vi.fn(async () => 'wrong-but-long-enough')
    const unlock = createPersonalUnlock(readSecret)
    const call = vi.fn(async () => {
      throw credentialRequired('claude')
    })

    await expect(withPersonalUnlock(unlock, 'Starting', call)).rejects.toThrow(
      /still needs a personal-credential unlock/,
    )
    expect(call).toHaveBeenCalledTimes(2)
    expect(readSecret).toHaveBeenCalledTimes(1)
  })

  it('leaves every other failure alone', async () => {
    // A 409 from the start path is the SYSTEM-token refusal, which no password can fix. Prompting
    // for one would ask an operator to solve a problem that is not theirs to solve at that prompt.
    const readSecret = vi.fn(async (_prompt: string) => 'hunter2')
    const unlock = createPersonalUnlock(readSecret)
    const conflict = new CatFactoryConflictError({
      status: 409,
      code: 'individual_model_unsupported',
      message: 'needs a personal-credential unlock',
      requestId: 'req_2',
      body: null,
    })

    await expect(
      withPersonalUnlock(unlock, 'Starting', async () => {
        throw conflict
      }),
    ).rejects.toBe(conflict)
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('names the vendor honestly when the deployment did not', async () => {
    const unlock = createPersonalUnlock(async () => 'hunter2')
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(credentialRequired())
      .mockResolvedValueOnce('started')

    await expect(withPersonalUnlock(unlock, 'Starting', call)).resolves.toBe('started')
  })
})

/**
 * A terminal that records what was asked of it, tracking `isRaw` the way the real stream does (the
 * cleanup reads it), and able to refuse raw mode BOTH ways a real one does.
 *
 * The two refusals are the point of this fake. Node's `setRawMode` reports a failure by EMITTING
 * `'error'`; that reaches a caller as a throw only because an `'error'` with no listener is what
 * Node turns into one. So a stream someone else is already listening to fails by returning normally
 * with `isRaw` still false, and modelling only the throw is what let that path go unnoticed.
 */
function fakeTerminal(options: { refuseRawMode?: unknown; refuseBy?: 'throw' | 'emit' } = {}) {
  const calls: string[] = []
  const listeners = new Map<string, ((value: unknown) => void)[]>()
  const input = {
    isRaw: false,
    destroyed: false,
    on(event: string, listener: (value: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return this
    },
    off(event: string, listener: (value: unknown) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((entry) => entry !== listener),
      )
      return this
    },
    setRawMode(raw: boolean) {
      calls.push(`setRawMode(${raw})`)
      if (raw && options.refuseRawMode !== undefined) {
        const listening = listeners.get('error') ?? []
        // Exactly Node's own shape: emit, and leave `isRaw` where it was.
        if (options.refuseBy === 'emit' && listening.length > 0) {
          for (const listener of listening) listener(options.refuseRawMode)
          return this
        }
        throw options.refuseRawMode
      }
      this.isRaw = raw
      return this
    },
    destroy() {
      calls.push('destroy')
    },
  }
  return { input: input as unknown as ReadStream, calls }
}

const RAW_MODE_EPERM = Object.assign(new Error('setRawMode EPERM'), {
  code: 'EPERM',
  errno: -4048,
})

describe('enterRawMode', () => {
  it('leaves a real terminal in raw mode', () => {
    const { input, calls } = fakeTerminal()
    const cleanup = vi.fn()

    enterRawMode(input, cleanup)
    expect(calls).toEqual(['setRawMode(true)'])
    expect(cleanup).not.toHaveBeenCalled()
  })

  // A device that opens and still will not stop echoing is a terminal that emulates a console
  // without implementing its modes, and it is NOT a missing console: a console-less process cannot
  // open `CONIN$` at all. The refusal has to name that cause, because the missing-console remedies
  // ("run it from an interactive shell") are both dead ends for someone already in one.
  it('refuses a terminal that will not stop echoing, naming THAT cause and its way out', () => {
    const cleanup = vi.fn()

    let thrown: unknown
    try {
      enterRawMode(fakeTerminal({ refuseRawMode: RAW_MODE_EPERM }).input, cleanup, 'win32')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('will not turn OFF echo')
    expect(message).toContain('winpty')
    expect(message).toContain('provider API key')
    // NOT cmd.exe, though it implements console modes perfectly well: `operatorText.ts` cannot tell
    // it from PowerShell and prints PowerShell, so sending an operator there would fix this one
    // prompt and break every command printed to them afterwards.
    expect(message).not.toContain('cmd.exe')
    // Not the other refusal: this operator's shell is interactive, and saying otherwise sends them
    // to redo the one thing they already did.
    expect(message).not.toContain('no terminal to ask on')
    expect(message).not.toContain('interactive shell')
    // The errno is the only part worth reading when the failure is something else entirely.
    expect((thrown as Error).cause).toBe(RAW_MODE_EPERM)
    // The fds it opened are released, so a refused prompt does not leak the console handle.
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  // The failure that a try/catch alone cannot see, and the one with the worst consequence: Node
  // reports a refused mode switch by EMITTING, so anything else already listening on the stream (a
  // `readline` interface, vitest's own watch-mode key handling) turns the refusal into a normal
  // return. Read as success, the prompt then takes the operator's password with echo ON, into the
  // scrollback, which is the single thing this whole file exists to prevent.
  it('refuses a terminal that reported its failure by EMITTING rather than throwing', () => {
    const { input } = fakeTerminal({ refuseBy: 'emit', refuseRawMode: RAW_MODE_EPERM })
    // Something ELSE in the process is already listening, which is the ordinary state of
    // `process.stdin` (a `readline` interface, vitest's own watch-mode keys) and the fallback path
    // this prompt takes when `/dev/tty` cannot be opened. Node's `setRawMode` then reports its
    // failure by emitting to that listener and returning normally, so a try/catch sees success.
    input.on('error', () => {})
    const cleanup = vi.fn()

    expect(() => enterRawMode(input, cleanup)).toThrow(/will not turn OFF echo/)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('refuses a switch that reported nothing and applied nothing either', () => {
    // A stream whose handle has gone assigns `isRaw` from a call that reached no device, so the flag
    // alone reports success. `isRaw` is the verdict, and it is only a verdict beside a live stream.
    const { input } = fakeTerminal()
    Object.assign(input, { destroyed: true })
    const cleanup = vi.fn()

    expect(() => enterRawMode(input, cleanup)).toThrow(/will not turn OFF echo/)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('names the POSIX way out on POSIX, where this refusal is just as reachable', () => {
    // `/dev/tty` opens and `tcsetattr` fails in ordinary places: a `docker exec` with no `-t`, a
    // detached `screen`/`tmux`. Told to install `winpty` and switch to a Windows terminal, that
    // operator gets a confident refusal naming the wrong cause, which is the defect this file was
    // written to fix, reintroduced on the other platform.
    const { input } = fakeTerminal({ refuseRawMode: RAW_MODE_EPERM })

    let thrown: unknown
    try {
      enterRawMode(input, () => {}, 'linux')
    } catch (error) {
      thrown = error
    }

    const message = (thrown as Error).message
    expect(message).toContain('will not turn OFF echo')
    expect(message).toContain('docker exec -t')
    expect(message).not.toContain('winpty')
    expect(message).not.toContain('Windows Terminal')
    expect(message).toContain('provider API key')
  })

  it('reports that refusal rather than a failure of its own cleanup', () => {
    // Driven through the REAL cleanup, which is the half a stand-in `vi.fn()` cannot grade: it
    // cannot fail, and the shipped one did. It closed the descriptor the stream had already closed,
    // so `EBADF: bad file descriptor, close` came out of the catch below and REPLACED the only
    // message that names the password and a way out.
    const { input, calls } = fakeTerminal({ refuseRawMode: RAW_MODE_EPERM })
    const closeFd = vi.fn()

    expect(() => enterRawMode(input, () => releaseTerminal(input, 7, closeFd))).toThrow(
      /will not turn OFF echo/,
    )
    // Echo is NOT put back on a device that never came off it, and the console handle is released.
    expect(calls).toEqual(['setRawMode(true)', 'destroy'])
    expect(closeFd).toHaveBeenCalledTimes(1)
    expect(closeFd).toHaveBeenCalledWith(7)
  })
})

// The cleanup runs on every exit path, including the refusal above and the instant a typed password
// is ACCEPTED, so the one thing it may not do is throw. It threw on both: the descriptor a
// `ReadStream` is constructed with is closed by DESTROYING the stream, and the `closeSync(fd)` beside
// that was an `EBADF` which replaced the refusal on one path and left the promise unsettled on the
// other, hanging a prompt that had already succeeded.
describe('releaseTerminal', () => {
  it('closes the descriptor it OWNS, and leaves the stream to close its own', () => {
    const { input, calls } = fakeTerminal()
    input.setRawMode(true)
    const closeFd = vi.fn((fd: number) => calls.push(`close(${fd})`))

    releaseTerminal(input, 7, closeFd)

    // Echo back on while the device is still there, then exactly one close: the OUTPUT descriptor.
    expect(calls).toEqual(['setRawMode(true)', 'setRawMode(false)', 'destroy', 'close(7)'])
  })

  it('closes nothing when the prompt never got an output device to write to', () => {
    const { input, calls } = fakeTerminal()
    input.setRawMode(true)

    releaseTerminal(input, null, (fd) => calls.push(`close(${fd})`))
    expect(calls).toEqual(['setRawMode(true)', 'setRawMode(false)', 'destroy'])
  })

  it('does not take a device out of a mode this prompt never put it in', () => {
    // `setRawMode` reports its failure by EMITTING on the stream, which a stream with no `error`
    // listener throws, so asking a device that never entered raw mode to leave it would stack a
    // second failure on top of the one being reported.
    const { input, calls } = fakeTerminal()

    releaseTerminal(input, null, (fd) => calls.push(`close(${fd})`))
    expect(calls).toEqual(['destroy'])
  })
})

/** A readable that hands over one chunk, the way the console does once a key is pressed. */
function typing(chunk: string) {
  const handlers: ((chunk: string) => void)[] = []
  const input = {
    isRaw: true,
    resume() {},
    setEncoding(_encoding: string) {},
    on(_event: string, handler: (chunk: string) => void) {
      handlers.push(handler)
      queueMicrotask(() => handler(chunk))
      return this
    },
    off() {
      return this
    },
  }
  return input as unknown as ReadStream
}

describe('readWithoutEcho', () => {
  it('answers what was typed, up to the Enter that ends it', async () => {
    const written: string[] = []
    const value = await readWithoutEcho(
      { input: typing('hunter2\r'), write: (text) => written.push(text) },
      'Personal password: ',
    )

    expect(value).toBe('hunter2')
    // The prompt, then the newline the suppressed echo did not print.
    expect(written).toEqual(['Personal password: ', '\n'])
  })

  it('settles even when the console handle dies between the password and the newline', async () => {
    // The newline is cosmetic and runs inside the `data` handler, so written BEFORE the settle its
    // failure escapes through `emit` and the promise never resolves at all: `readSecretFromTty`'s
    // `finally` never runs, echo is never put back, and a prompt that had ALREADY SUCCEEDED hangs
    // the pass and leaves the operator in a shell they can type into and not see.
    const value = await readWithoutEcho(
      {
        input: typing('hunter2\r'),
        write: (text) => {
          if (text === '\n')
            throw Object.assign(new Error('EBADF: bad file descriptor, write'), {
              code: 'EBADF',
            })
        },
      },
      'Personal password: ',
    )

    expect(value).toBe('hunter2')
  })

  it('reports the operator declining as its own type, not as an empty password', async () => {
    // Ctrl-C. Its own class because the up-front ask treats it oppositely to every other failure it
    // can meet: those degrade to asking later, this one stops the pass.
    await expect(
      readWithoutEcho({ input: typing('\u0003'), write: () => {} }, 'Personal password: '),
    ).rejects.toBeInstanceOf(PersonalPasswordDeclined)
  })
})
