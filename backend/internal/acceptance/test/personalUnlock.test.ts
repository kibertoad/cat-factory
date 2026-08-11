import { CatFactoryCredentialRequiredError, CatFactoryConflictError } from '@cat-factory/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createPersonalUnlock, withPersonalUnlock } from '../src/personalUnlock.ts'

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
