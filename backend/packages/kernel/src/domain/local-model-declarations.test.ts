import { describe, expect, it } from 'vitest'
import {
  declaredLocalModel,
  parseLocalModelDeclarations,
  resolveLocalModelModality,
  withLocalModelDeclaration,
} from './local-model-declarations.js'
import { resolveDesignImageDelivery } from './design-image-delivery.js'

const OLLAMA = {
  provider: 'ollama',
  models: [
    { id: 'muse-glimmer:30b', acceptsImages: true },
    { id: 'qwen3', acceptsImages: false },
    { id: 'gemma3' },
  ],
}

describe('declaredLocalModel', () => {
  it('finds the declaration for a local ref, matching runner AND model', () => {
    expect(declaredLocalModel({ provider: 'ollama', model: 'gemma3' }, [OLLAMA])).toEqual({
      id: 'gemma3',
    })
  })

  it('does not answer from ANOTHER runner that happens to serve the same model id', () => {
    // Two runners can serve one model id and need not agree about it (an image-capable build on
    // one, a text-only quant on the other). Matching on the id alone would let one runner's
    // declaration decide what the other is sent.
    expect(
      declaredLocalModel({ provider: 'lmstudio', model: 'muse-glimmer:30b' }, [OLLAMA]),
    ).toBeUndefined()
  })

  it('is undefined for a non-local provider, an unknown model, and no declarations', () => {
    expect(
      declaredLocalModel({ provider: 'workers-ai', model: 'gemma3' }, [OLLAMA]),
    ).toBeUndefined()
    expect(declaredLocalModel({ provider: 'ollama', model: 'nope' }, [OLLAMA])).toBeUndefined()
    expect(declaredLocalModel({ provider: 'ollama', model: 'gemma3' }, undefined)).toBeUndefined()
  })
})

describe('resolveLocalModelModality', () => {
  it('answers from the recognised-family table when the user declared nothing', () => {
    // The point of the table: pulling Gemma 4 and ticking it is enough, with no second step.
    expect(resolveLocalModelModality('gemma4:12b', undefined)).toBe(true)
    expect(resolveLocalModelModality('muse-glimmer:30b', { id: 'muse-glimmer:30b' })).toBe(true)
  })

  it('lets the USER out-rank the table, in both directions', () => {
    // They pulled the weights, so they are the one who knows: a text-only quant of a recognised
    // family must be able to say so, and an unrecognised fine-tune must be able to opt in.
    expect(
      resolveLocalModelModality('gemma4:12b', { id: 'gemma4:12b', acceptsImages: false }),
    ).toBe(false)
    expect(
      resolveLocalModelModality('my-finetune', { id: 'my-finetune', acceptsImages: true }),
    ).toBe(true)
  })

  it('stays UNDECLARED when neither tier knows', () => {
    expect(resolveLocalModelModality('my-finetune', undefined)).toBeUndefined()
    expect(
      resolveLocalModelModality('qwen2.5-coder:32b', { id: 'qwen2.5-coder:32b' }),
    ).toBeUndefined()
  })
})

describe('withLocalModelDeclaration', () => {
  it('folds a declared modality onto the ref, either way', () => {
    expect(
      withLocalModelDeclaration({ provider: 'ollama', model: 'muse-glimmer:30b' }, [OLLAMA]),
    ).toEqual({ provider: 'ollama', model: 'muse-glimmer:30b', acceptsImages: true })
    expect(withLocalModelDeclaration({ provider: 'ollama', model: 'qwen3' }, [OLLAMA])).toEqual({
      provider: 'ollama',
      model: 'qwen3',
      acceptsImages: false,
    })
  })

  it('folds the RECOGNISED family onto a model the user enabled without declaring', () => {
    // No declaration for `gemma4` anywhere in OLLAMA's list, so this is the table answering — the
    // path that makes ticking a popular model enough on its own.
    expect(
      withLocalModelDeclaration({ provider: 'ollama', model: 'gemma4:12b' }, [OLLAMA]),
    ).toEqual({ provider: 'ollama', model: 'gemma4:12b', acceptsImages: true })
  })

  it('leaves an UNDECLARED model absent rather than stamping a false', () => {
    // The whole point of the third state: the two dispositions send a reader to opposite places.
    const undeclared = withLocalModelDeclaration({ provider: 'ollama', model: 'gemma3' }, [OLLAMA])
    expect(undeclared).not.toHaveProperty('acceptsImages')
    expect(resolveDesignImageDelivery({ channel: 'message' }, undeclared)).toEqual({
      attached: false,
      reason: 'unknown_model_image_input',
    })
    expect(
      resolveDesignImageDelivery(
        { channel: 'message' },
        withLocalModelDeclaration({ provider: 'ollama', model: 'qwen3' }, [OLLAMA]),
      ),
    ).toEqual({ attached: false, reason: 'model_no_image_input' })
  })

  it('passes a NON-LOCAL ref through untouched, declarations or not', () => {
    // A catalog model's modality comes off its own flavour; a per-user declaration must never
    // displace it (nor invent one for a provider that has no local endpoint at all).
    const catalog = { provider: 'workers-ai', model: '@cf/meta/llama-4-scout', acceptsImages: true }
    expect(
      withLocalModelDeclaration(catalog, [
        {
          provider: 'workers-ai',
          models: [{ id: '@cf/meta/llama-4-scout', acceptsImages: false }],
        },
      ]),
    ).toBe(catalog)
  })

  it('keeps everything else on the ref (the harness, the window) when it folds', () => {
    expect(
      withLocalModelDeclaration(
        { provider: 'ollama', model: 'muse-glimmer:30b', contextTokens: 131_072 },
        [OLLAMA],
      ),
    ).toEqual({
      provider: 'ollama',
      model: 'muse-glimmer:30b',
      contextTokens: 131_072,
      acceptsImages: true,
    })
  })
})

describe('parseLocalModelDeclarations', () => {
  it('round-trips what a store wrote', () => {
    expect(parseLocalModelDeclarations(JSON.stringify(OLLAMA.models))).toEqual(OLLAMA.models)
  })

  it('drops a pre-declaration BARE STRING entry instead of coercing it', () => {
    // The shape these rows held before declarations existed. `String(entry)` would have minted a
    // model id, and an object with no `id` an entry nothing can render — so the break arrives as an
    // empty enabled list the panel reports, which is what sends the user to re-tick.
    expect(parseLocalModelDeclarations(JSON.stringify(['gemma3', 'qwen3']))).toEqual([])
    expect(
      parseLocalModelDeclarations(JSON.stringify([{ id: 'ok' }, 'gemma3', { id: '' }])),
    ).toEqual([{ id: 'ok' }])
  })

  it('ignores a non-boolean modality rather than truthy-coercing it', () => {
    expect(
      parseLocalModelDeclarations(JSON.stringify([{ id: 'a', acceptsImages: 'yes' }])),
    ).toEqual([{ id: 'a' }])
  })

  it('answers empty for malformed JSON and for a non-array payload', () => {
    expect(parseLocalModelDeclarations('{')).toEqual([])
    expect(parseLocalModelDeclarations('null')).toEqual([])
    expect(parseLocalModelDeclarations('{"id":"a"}')).toEqual([])
  })
})
