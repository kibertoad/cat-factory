// The sharing rule, against compiled tiers rather than against a Worker.
//
// What `addObserver` has to decide is a comparison of two tiers, and everything around it (a
// verifier stub, an account, a resource object) is lookup. So the comparison is exercised here on
// tiers built for each of the three tests it makes, and `os.spec.ts` covers the one thing this
// file cannot: that a real resource object asks the question at all.

import { describe, expect, it } from 'vitest'
import { assertObserverMaySee, identifyObserver } from '../src/index.js'
import { compilePolicy, type CompiledTier, type GatekeeperPolicy } from '../src/policy/index.js'

const READS = ['services_list', 'tasks_get', 'tasks_get_run'] as const

function tiers(spec: GatekeeperPolicy['tiers']): Record<string, CompiledTier> {
  const compiled = compilePolicy({ defaultTier: null, tiers: spec, grants: {} })
  return Object.fromEntries(compiled.tiers)
}

function readTier(
  allow: readonly string[],
  extra: Partial<GatekeeperPolicy['tiers'][string]> = {},
): CompiledTier {
  const name = 'tier'
  const compiled = tiers({
    [name]: { description: 'a reading tier', keyScope: 'read', allow, ...extra },
  })
  return compiled[name] as CompiledTier
}

describe('identifyObserver', () => {
  it('refuses a viewer that offers no verifier to question', async () => {
    await expect(identifyObserver({})).rejects.toThrow(/no verifier this Gatekeeper can question/)
  })

  it('refuses a verifier that names no account, rather than sharing with an unnamed one', async () => {
    await expect(identifyObserver({ describe: async () => ({}) })).rejects.toThrow(
      /named no account/,
    )
  })

  it('reports a verifier that could not be questioned as unverifiable, not as unauthorised', async () => {
    const thrower = {
      describe: async () => {
        throw new Error('the workspace hung up')
      },
    }

    // The two are the same outcome and opposite facts: one is a viewer this deployment refuses,
    // the other is a question it failed to ask.
    await expect(identifyObserver(thrower)).rejects.toThrow(/could not be questioned/)
  })

  it('answers the account id when the verifier names one', async () => {
    await expect(
      identifyObserver({ describe: async () => ({ accountId: 'acct_1' }) }),
    ).resolves.toBe('acct_1')
  })
})

describe('assertObserverMaySee', () => {
  function share(owner: CompiledTier, observer: CompiledTier): void {
    assertObserverMaySee({ observerId: 'obs', observerAccount: 'acct_2', owner, observer })
  }

  it('admits an observer whose tier reaches everything the bound tier does', () => {
    const owner = readTier(READS)
    const observer = readTier([...READS, 'pipelines_list'])

    // A superset, not an equality: the question is whether they could read it all themselves, and
    // holding more than the owner does not make them able to read less.
    expect(() => share(owner, observer)).not.toThrow()
  })

  it('refuses an observer missing an operation the bound tier holds, naming it', () => {
    expect(() => share(readTier(READS), readTier(['services_list']))).toThrow(
      /does not grant 'tasks_get', 'tasks_get_run'/,
    )
  })

  it('refuses an observer whose tier masks a field the bound tier does not', () => {
    const owner = readTier(READS)
    const observer = readTier(READS, { mask: ['run.pullRequestUrl'] })

    // Masking is redaction on the way out, so a field the observer's own tier blanks is one they
    // cannot read directly even through an operation they hold.
    expect(() => share(owner, observer)).toThrow(/masks 'run.pullRequestUrl'/)
  })

  it('admits an observer masking no more than the bound tier does', () => {
    const owner = readTier(READS, { mask: ['run.pullRequestUrl'] })
    const observer = readTier(READS, { mask: ['run.pullRequestUrl'] })

    expect(() => share(owner, observer)).not.toThrow()
  })

  it('refuses any share from a tier that can read captured agent text', () => {
    const owner = readTier([...READS, 'debug_list_llm_calls'])
    const observer = readTier([...READS, 'debug_list_llm_calls'])

    // Even to an identical tier. Those reads are described with `prohibitAllSharing`, which is a
    // statement about the DATA rather than about the viewer, and nothing here records which of
    // them were actually made.
    expect(() => share(owner, observer)).toThrow(/not shareable onward whatever the viewer holds/)
  })
})
