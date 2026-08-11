import { describe, expect, it } from 'vitest'
import { KNOWN_LOCAL_MODELS, knownLocalModel, squashModelId } from './known-local-models.js'

// The table exists so the common case needs no hand-declaration. What has to hold is that one
// entry covers every SPELLING the ecosystem serves the same weights under, and that it never
// reaches a NEIGHBOURING family — a wrong match is worse than no match, because it hands a
// picture to a model that cannot read it (or, in the version case, claims a capability the
// user's build does not have).

describe('squashModelId', () => {
  it('drops the org prefix, the size tag, the quantisation and the format', () => {
    expect(squashModelId('google/gemma-4-12b')).toBe('gemma412b')
    expect(squashModelId('gemma4:12b')).toBe('gemma412b')
    expect(squashModelId('lmstudio-community/Muse-Glimmer-30B-GGUF')).toBe('museglimmer30bgguf')
    expect(squashModelId('/models/muse-glimmer-30b-q4_k_m.gguf')).toBe('museglimmer30bq4kmgguf')
  })

  it('keeps version DIGITS significant', () => {
    // The one thing the squash must not lose: `gemma3` and `gemma4` differ only here, and they
    // differ in whether the small sizes read images at all.
    expect(squashModelId('gemma3:1b')).not.toContain('gemma4')
  })
})

describe('knownLocalModel', () => {
  it('recognises one family across Ollama, LM Studio, llama.cpp and MLX spellings', () => {
    for (const id of [
      'muse-glimmer:30b',
      'muse-glimmer:30b-mlx',
      'meta-models/Muse-Glimmer-30B',
      'lmstudio-community/Muse-Glimmer-30B-GGUF',
      'mlx-community/Muse-Glimmer-30B-4bit',
      '/models/muse-glimmer-30b-q4_k_m.gguf',
    ]) {
      expect(knownLocalModel(id), id).toMatchObject({ family: 'muse-glimmer', acceptsImages: true })
    }
  })

  it('recognises Gemma 4 at every size, and does NOT claim Gemma 3', () => {
    // Gemma 4 ships native vision in every variant, which is what makes the bare family name
    // safe. Gemma 3's 1B is text-only while its larger siblings are not, so the family is absent
    // and a `gemma3` id falls through to the user's own declaration.
    expect(knownLocalModel('gemma4')?.family).toBe('gemma4')
    expect(knownLocalModel('gemma4:2b')?.family).toBe('gemma4')
    expect(knownLocalModel('google/gemma-4-31b-it')?.family).toBe('gemma4')
    expect(knownLocalModel('gemma3:1b')).toBeUndefined()
    expect(knownLocalModel('gemma3:27b')).toBeUndefined()
  })

  it('recognises Qwen only where VISION is explicit in the id', () => {
    expect(knownLocalModel('qwen3.6-vl:32b')?.family).toBe('qwen-vl')
    expect(knownLocalModel('Qwen/Qwen2.5-VL-7B-Instruct')?.family).toBe('qwen-vl')
    // The plain series is left unrecognised on purpose: its vision story is delivered by the
    // `-VL` builds, and guessing on a coder model would withhold nothing but would MIS-state
    // that a text-only build reads images.
    expect(knownLocalModel('qwen3.6:27b')).toBeUndefined()
    expect(knownLocalModel('qwen2.5-coder:32b')).toBeUndefined()
  })

  it('answers undefined for an unknown model and for no id at all', () => {
    expect(knownLocalModel('my-private-finetune-v3')).toBeUndefined()
    expect(knownLocalModel('deepseek-r1:70b')).toBeUndefined()
    expect(knownLocalModel('')).toBeUndefined()
    expect(knownLocalModel(undefined)).toBeUndefined()
  })

  it('carries only entries whose SILENCE would cost a capability', () => {
    // Stated as the structural property rather than a pinned count, so adding a family is an
    // ordinary change: every member must be image-capable (a text-only entry behaves identically
    // to an absent one, so it would be maintenance with no effect), and every match fragment must
    // already be squashed or it could never match a squashed id.
    for (const known of KNOWN_LOCAL_MODELS) {
      expect(known.acceptsImages, known.family).toBe(true)
      expect(known.match.length, known.family).toBeGreaterThan(0)
      for (const fragment of known.match) {
        expect(squashModelId(fragment), `${known.family}: ${fragment}`).toBe(fragment)
      }
    }
  })
})
