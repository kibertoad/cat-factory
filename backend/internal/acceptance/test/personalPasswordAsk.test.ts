import { describe, expect, it, vi } from 'vitest'
import { askForPersonalPassword } from '../src/personalPasswordAsk.ts'
import { PersonalPasswordDeclined } from '@cat-factory/acceptance-kit/console-credential'
import type { PinnedPreset } from '../src/presets.ts'

// This ask runs before the first prerequisite is evaluated and before a journal line exists, so
// what is pinned here is what it does when something goes wrong: everything it meets except a person
// declining leaves the pass running, because a refusal thrown from here IS the operator's whole
// output. The one exception is pinned too, for the opposite reason.

const pinnedOn = (overrides: Partial<PinnedPreset['model']> = {}): PinnedPreset => ({
  preset: { name: 'Claude (default)' },
  model: {
    modelId: 'claude-opus-5',
    label: 'Claude Opus 5',
    provider: 'claude',
    available: true,
    personalSubscription: true,
    ...overrides,
  },
})

function harness(overrides: Partial<Parameters<typeof askForPersonalPassword>[0]> = {}) {
  const logs: string[] = []
  // What the HOLDER was given, which is the whole observable effect: nothing hands a password back
  // any more (the ask fills the unlock's own closure), so a test watches the holder rather than a
  // value.
  const held: string[] = []
  const deps = {
    log: (message: string) => logs.push(message),
    readPinned: async () => pinnedOn(),
    hold: async (_reason: string) => {
      held.push('hunter2')
    },
    ...overrides,
  }
  return { deps, logs, held, said: (text: string) => logs.some((line) => line.includes(text)) }
}

describe('askForPersonalPassword', () => {
  it('asks once and leaves the password in the holder for the whole pass', async () => {
    const { deps, held } = harness()

    await askForPersonalPassword(deps)

    expect(held).toEqual(['hunter2'])
  })

  it('names the preset and the model, so the prompt says what it is spending', async () => {
    const hold = vi.fn(async (_reason: string) => {})
    await askForPersonalPassword(harness({ hold }).deps)

    expect(hold).toHaveBeenCalledTimes(1)
    const reason = hold.mock.calls[0]?.[0] ?? ''
    expect(reason).toContain('Claude (default)')
    expect(reason).toContain('Claude Opus 5')
    expect(reason).toContain('claude subscription')
  })

  it('scrubs what the deployment supplied, one line above a password prompt', async () => {
    // Both values are strings this process did not write: the preset name is typed by whoever
    // configured the workspace, the label comes back from the deployment. Every other operator-facing
    // render in this suite is scrubbed, and this is the one printed next to a credential prompt.
    const hold = vi.fn(async (_reason: string) => {})
    await askForPersonalPassword(
      harness({
        readPinned: async () => ({
          preset: { name: 'via https://svc:hunter2@models.example.com' },
          model: { ...pinnedOn().model, label: 'https://svc:s3cret@models.example.com/opus' },
        }),
        hold,
      }).deps,
    )

    const reason = hold.mock.calls[0]?.[0] ?? ''
    expect(reason).not.toContain('hunter2@')
    expect(reason).not.toContain('s3cret')
    expect(reason).toContain('[REDACTED]')
  })

  it('asks nothing for a workspace running on a provider key', async () => {
    const hold = vi.fn(async (_reason: string) => {})
    const { deps, logs } = harness({
      readPinned: async () => pinnedOn({ personalSubscription: false }),
      hold,
    })

    await askForPersonalPassword(deps)

    expect(hold).not.toHaveBeenCalled()
    // Silent as well as unasked: there is nothing here for that operator to act on.
    expect(logs).toEqual([])
  })

  // The other half of the rule that lets the ask HOLD what it collects: it only ever asks where the
  // deployment CONFIRMED this pass will spend a subscription. Unconfirmed, nothing is asked and
  // nothing is held, and the `428` path is the whole behaviour.
  it('leaves the ask to the first dispatch when the deployment could not be read', async () => {
    const hold = vi.fn(async (_reason: string) => {})
    const { deps, said } = harness({
      readPinned: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8787')
      },
      hold,
    })

    await askForPersonalPassword(deps)

    expect(hold).not.toHaveBeenCalled()
    expect(said('connect ECONNREFUSED 127.0.0.1:8787')).toBe(true)
    expect(said('comes at that first dispatch instead')).toBe(true)
  })

  it('says so, once, when the preset is simply not in the library', async () => {
    const { deps, said, logs } = harness({ readPinned: async () => null })

    await askForPersonalPassword(deps)

    expect(said('Could not tell yet')).toBe(true)
    // `model-preset` is a REQUIRED prerequisite with the library listed and a remedy attached; a
    // second, vaguer voice from a process with no journal is the worse of the two.
    expect(logs).toHaveLength(1)
  })

  // The finding this file exists for. A refusal thrown from the up-front ask aborts before the
  // preflight has evaluated a single prerequisite: no "your key names another workspace", no "the
  // pinned preset's model is unwired", no ledger, no journal. Printed instead, the pass reaches the
  // gate that owns diagnosing it, and the same ask arrives at the dispatch that needs one.
  it('continues the pass when there is no terminal to ask on', async () => {
    const { deps, held, said } = harness({
      hold: async () => {
        throw new Error('this process has no terminal to ask on.')
      },
    })

    await expect(askForPersonalPassword(deps)).resolves.toBeUndefined()

    expect(held).toEqual([])
    expect(said('no terminal to ask on')).toBe(true)
    expect(said('The pass continues from here')).toBe(true)
  })

  it('continues, too, when the terminal will not stop echoing', async () => {
    const { deps, said } = harness({
      hold: async () => {
        throw new Error('that terminal will not turn OFF echo')
      },
    })

    await askForPersonalPassword(deps)
    expect(said('will not turn OFF echo')).toBe(true)
  })

  it('stops the pass when the operator DECLINES, which is not a degradation', async () => {
    // The opposite disposition, and it is the difference between a limit of where the pass is
    // running and a person saying "not this pass". Degraded like the others, Ctrl-C at the prompt
    // would start an afternoon-long run that spends real money.
    const { deps, held } = harness({
      hold: async () => {
        throw new PersonalPasswordDeclined()
      },
    })

    await expect(askForPersonalPassword(deps)).rejects.toBeInstanceOf(PersonalPasswordDeclined)
    expect(held).toEqual([])
  })

  it('holds nothing when the password itself was refused, rather than a blank one', async () => {
    const { deps, held, said } = harness({
      hold: async () => {
        throw new Error('A password is at least 6 characters. The run cannot be unlocked.')
      },
    })

    await askForPersonalPassword(deps)

    expect(held).toEqual([])
    expect(said('at least 6 characters')).toBe(true)
  })
})
