import { describe, expect, it } from 'vitest'
import type { LanguageModel } from 'ai'
import { runSpecialistPanel } from './specialistPanel.js'
import type { GenerateFn, ResolvedParticipant } from './types.js'

// A panel's usage fold, at the grain the kernel unit test cannot see: whether the split a
// participant's provider DID report survives a panel that also holds one whose provider
// reported none. A panel is multi-model by design, so that mix is its normal state, not a
// producer contradicting itself.

const model = 'fake-model' as unknown as LanguageModel

function participant(id: string): ResolvedParticipant {
  return { id, role: id, model, modelLabel: `fake:${id}` }
}

/**
 * Anthropic-shaped participants report their cache split; the Workers AI one reports none
 * (`workers-ai-provider` passes no `inputTokenDetails` through). The synthesizer answers with a
 * split too, so the unsplit part is a strict minority of the panel.
 */
const mixedProviderGenerate: GenerateFn = async ({ system }) => {
  const isSynth = system.startsWith('You are a neutral synthesizer')
  if (!isSynth && system.includes('unsplit')) {
    return { text: 'draft', usage: { inputTokens: 1_000, outputTokens: 10 } }
  }
  return {
    text: isSynth ? 'SYNTHESIZED' : 'draft',
    usage: {
      inputTokens: 1_000,
      outputTokens: 10,
      inputClasses: { promptTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 },
    },
  }
}

describe('a panel folding usage across providers', () => {
  it('keeps the reporting participants cache reads when one provider reports no split', async () => {
    const result = await runSpecialistPanel({
      agentKind: 'coder',
      baseSystem: 'base',
      goalPrompt: 'goal',
      participants: [
        participant('cached-a'),
        { ...participant('unsplit'), systemFraming: 'unsplit' },
      ],
      synthesizer: { model, modelLabel: 'fake:synth' },
      rounds: 1,
      generate: mixedProviderGenerate,
      tags: { agentKind: 'coder' },
    })

    // Two reporting calls contribute 900 cache reads each; the unsplit participant's whole
    // input lands on the fresh class, which is exactly what it would have been charged alone.
    expect(result.usage).toEqual({
      inputTokens: 3_000,
      outputTokens: 30,
      inputClasses: { promptTokens: 1_200, cacheReadTokens: 1_800, cacheWriteTokens: 0 },
    })
  })
})
