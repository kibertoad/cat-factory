import { describe, expect, it } from 'vitest'
import {
  BinaryGeneratorRegistry,
  defaultBinaryGeneratorRegistry,
  type BinaryGeneratorView,
} from './binary-generator-registry.js'
import {
  binaryGeneratorContextFileFor,
  binaryGeneratorSelectionIssues,
  describeBinaryGeneratorSelectionIssues,
  dispatchBinaryGenerators,
  renderBinaryGeneratorSection,
  resolveBinaryGeneratorSelection,
} from './binary-generators.js'
import { binaryContextFileFor, renderBinaryOutputBrief } from './binary-outputs.js'

function generator(overrides: Partial<BinaryGeneratorView> = {}): BinaryGeneratorView {
  return {
    id: 'retro-diffusion',
    name: 'Retro Diffusion',
    summary: 'Pixel-art image generation.',
    description: 'Good for sprites and tiles; not for photorealism.',
    modalities: ['image'],
    mediaTypes: ['image/png'],
    endpoint: 'https://api.retrodiffusion.ai/v1',
    credential: { key: 'RD_TOKEN', usage: 'the X-RD-Token request header' },
    contracts: [],
    ...overrides,
  }
}

const music = generator({
  id: 'studio-music',
  name: 'Studio Music',
  summary: 'Instrumental music generation.',
  modalities: ['audio'],
  mediaTypes: ['audio/mpeg'],
  credential: { key: 'STUDIO_KEY' },
})

describe('BinaryGeneratorRegistry', () => {
  it('projects registered definitions and summarises their contracts', () => {
    const registry = defaultBinaryGeneratorRegistry()
    expect(registry.views()).toEqual([])
    registry.register({
      id: 'retro-diffusion',
      name: 'Retro Diffusion',
      summary: 'Pixel-art image generation.',
      description: 'Sprites and tiles.',
      modalities: ['image'],
      contracts: [
        {
          contractId: 'api',
          format: 'openapi',
          title: 'Inference API',
          body: 'openapi: 3.0.0\npaths:\n  /inferences:\n    post: {}\n',
        },
      ],
    })
    expect(registry.views()[0]?.contracts[0]?.operations).toEqual(['POST /inferences'])
    expect(registry.documentsFor('retro-diffusion')[0]?.body).toContain('openapi')
    expect(registry.ids()).toEqual(['retro-diffusion'])
  })

  it('replaces a registration of the same id and drops the memoised projection', () => {
    const registry = new BinaryGeneratorRegistry()
    const base = {
      id: 'gen',
      name: 'First',
      summary: 's',
      description: '',
      modalities: ['image'] as const,
    }
    registry.register({ ...base, modalities: ['image'] })
    expect(registry.views()[0]?.name).toBe('First')
    registry.register({ ...base, name: 'Second', modalities: ['video'] })
    expect(registry.views()).toHaveLength(1)
    expect(registry.views()[0]).toMatchObject({ name: 'Second', modalities: ['video'] })
  })
})

describe('binaryGeneratorSelectionIssues', () => {
  const registered = [generator(), music]

  it('accepts a selection whose integrations cover every content type the step declares', () => {
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['retro-diffusion', 'studio-music'],
          modalities: ['image', 'audio'],
        },
        registered,
      ),
    ).toEqual([])
  })

  it('refuses a content type no selected integration produces', () => {
    // The failure this rule exists for: a step told to deliver a theme song with only an image
    // generator selected runs to completion and apologises at the end of a paid run.
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['retro-diffusion'],
          modalities: ['image', 'audio'],
        },
        registered,
      ),
    ).toEqual([{ problem: 'modality_uncovered', modality: 'audio' }])
  })

  it('names an unregistered id and reports every issue rather than the first', () => {
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['ghost-synth', 'also-ghost'],
          modalities: ['video'],
        },
        registered,
      ),
    ).toEqual([
      { problem: 'unknown_generator', generatorId: 'ghost-synth' },
      { problem: 'unknown_generator', generatorId: 'also-ghost' },
      { problem: 'modality_uncovered', modality: 'video' },
    ])
  })

  it('imposes nothing when the step declares no content types', () => {
    // `modalities` is a statement about the WORK, so an absent one is not "produce anything" —
    // it is "the platform has nothing to check the selection against".
    expect(
      binaryGeneratorSelectionIssues(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
        registered,
      ),
    ).toEqual([])
  })

  // The format half. 3D is what forces it: GLB, USDZ and FBX are all one modality and
  // none substitutes for another, so a mesh in the wrong container is not a thinner deliverable
  // but an unusable one — and nothing downstream can tell it from a bad generation.
  const meshy = generator({
    id: 'meshy',
    name: 'Meshy',
    summary: 'Text- and image-to-3D.',
    modalities: ['3d-model'],
    mediaTypes: ['model/gltf-binary', 'model/obj'],
  })

  it('refuses a format no selected integration emits, even when the modality is covered', () => {
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['meshy'],
          modalities: ['3d-model'],
          mediaTypes: ['model/gltf-binary', 'model/fbx'],
        },
        [meshy],
      ),
    ).toEqual([{ problem: 'media_type_uncovered', mediaType: 'model/fbx' }])
  })

  it('checks EVERY declared format, so an engine build and an editable mesh are both covered', () => {
    // The two-consumer case: the game loads the GLB, an artist opens the FBX in Blender. Both are
    // required deliverables, so both are checked — this is why the list is not "any of these".
    const artist = generator({
      id: 'artist-3d',
      modalities: ['3d-model'],
      mediaTypes: ['model/fbx'],
    })
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['meshy', 'artist-3d'],
          mediaTypes: ['model/gltf-binary', 'model/fbx'],
        },
        [meshy, artist],
      ),
    ).toEqual([])
  })

  it('admits a format it could not judge, because an undeclared list is not an empty one', () => {
    // A generator that declares no `mediaTypes` has said "only my modality is known" — a
    // documented state. Refusing there would punish the honest declaration; the gap is STATED
    // in the brief and the picker instead. What ADMISSION owes is this half: only the uncovered
    // outcome refuses. The three outcomes themselves are contracts' `binaryFormatCoverage`.
    const undeclared = generator({ id: 'mystery-3d', modalities: ['3d-model'], mediaTypes: [] })
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['mystery-3d'],
          mediaTypes: ['model/fbx'],
        },
        [undeclared],
      ),
    ).toEqual([])
  })

  it('tells an asset generator from a scene generator, which no media type could', () => {
    // The split's own reason for existing: both emit GLB, so the FORMAT check passes and the
    // step still cannot be served. Without the two members a level-producing step would be
    // admitted against a prop generator with nothing anywhere able to notice.
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['meshy'],
          modalities: ['3d-scene'],
          mediaTypes: ['model/gltf-binary'],
        },
        [meshy],
      ),
    ).toEqual([{ problem: 'modality_uncovered', modality: '3d-scene' }])
  })

  it('refuses a format outright when NOTHING is selected to be silent about it', () => {
    // The empty selection reaches admission as a refusal rather than as an unverifiable gap: with
    // no integration to have declared nothing, the requirement is simply unmet.
    expect(
      binaryGeneratorSelectionIssues(
        { storageServiceId: 'asset-store', mediaTypes: ['model/fbx'] },
        [meshy],
      ),
    ).toEqual([{ problem: 'media_type_uncovered', mediaType: 'model/fbx' }])
  })

  it('does not translate a format into its modality, so an exotic one is checked as written', () => {
    // `modalityOfMediaType` knows only the formats the platform happens to recognise. Inferring a
    // modality here would make the coarse check fire for `model/gltf-binary` and silently not for
    // a brand-new container — the strength of a requirement must not depend on our vocabulary.
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['meshy'],
          mediaTypes: ['model/x-brand-new'],
        },
        [meshy],
      ),
    ).toEqual([{ problem: 'media_type_uncovered', mediaType: 'model/x-brand-new' }])
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['meshy'],
          mediaTypes: ['model/x-brand-new'],
        },
        [generator({ id: 'meshy', modalities: ['3d-model'], mediaTypes: ['model/x-brand-new'] })],
      ),
    ).toEqual([])
  })

  it('sends the reader to the DEPLOYMENT, not the workspace catalog', () => {
    const message = describeBinaryGeneratorSelectionIssues('image-generator', [
      { problem: 'unknown_generator', generatorId: 'ghost-synth' },
      { problem: 'modality_uncovered', modality: 'audio' },
    ])
    expect(message).toContain('ghost-synth')
    expect(message).toContain('audio')
    expect(message).toContain('BinaryGeneratorRegistry')
  })

  it('names a RETIRED content type rather than rendering it as undefined', () => {
    // `modalities` is persisted, so a member removed from the union outlives it in saved
    // pipelines — `3d` did exactly that when it split. Such a value is uncovered by every
    // registered integration by construction, so it reaches this message, which is the one whose
    // job is to say what must be re-picked. An exhaustive switch with no runtime arm rendered it
    // "produces undefined", turning a deliberate break into a nonsense sentence.
    const message = describeBinaryGeneratorSelectionIssues('image-generator', [
      { problem: 'modality_uncovered', modality: '3d' as never },
    ])
    expect(message).toContain("'3d'")
    expect(message).toContain('no longer defines')
    expect(message).not.toContain('undefined')
  })
})

describe('resolveBinaryGeneratorSelection', () => {
  it('resolves a repeated id ONCE, on both sides of the split', () => {
    // Nothing refuses a stored selection that names one integration twice, and every reader of
    // this states a count: a repeat renders that integration's whole brief entry a second time,
    // and reports a step as holding two producers of what it holds one of.
    expect(
      resolveBinaryGeneratorSelection(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['retro-diffusion', 'ghost', 'retro-diffusion', 'ghost'],
        },
        [generator()],
      ),
    ).toEqual({ selected: [generator()], unresolvedIds: ['ghost'] })
  })

  it('keeps selection order, because the brief and the picker both render in it', () => {
    const { selected } = resolveBinaryGeneratorSelection(
      { storageServiceId: 'asset-store', generatorIds: ['studio-music', 'retro-diffusion'] },
      [generator(), music],
    )
    expect(selected.map((view) => view.id)).toEqual(['studio-music', 'retro-diffusion'])
  })
})

describe('renderBinaryGeneratorSection', () => {
  it('separates the integrations by content type, so one is never asked for the other’s output', () => {
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['retro-diffusion', 'studio-music'],
          modalities: ['image', 'audio'],
        },
        [generator(), music],
      ),
      requestedModalities: ['image', 'audio'],
    }).join('\n')
    expect(section).toContain('`retro-diffusion`')
    expect(section).toContain('Produces: images.')
    expect(section).toContain('`studio-music`')
    expect(section).toContain('Produces: audio (music, speech or sound).')
    expect(section).toContain('never ask one for a kind of output it does not produce')
  })

  it('names the credential variable and what an unset one means', () => {
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
        [generator()],
      ),
      requestedModalities: [],
    }).join('\n')
    expect(section).toContain('`RD_TOKEN`')
    expect(section).toContain('the X-RD-Token request header')
    expect(section).toContain('do not call `retro-diffusion` at all')
  })

  it('names the INJECTION variable, never the lookup key, when a declaration splits them', () => {
    // The two differ whenever a definition had to keep a vendor's documented variable name while
    // looking the value up under one of its own (the reserved-family escape). Naming the lookup
    // key here would tell the agent to read a variable that is never set: an integration reported
    // unavailable on every run, with the brief itself as the reason nobody could see it.
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
        [generator({ credential: { key: 'ACME_RD_TOKEN', envName: 'GITHUB_MODELS_TOKEN' } })],
      ),
      requestedModalities: [],
    }).join('\n')
    expect(section).toContain('`GITHUB_MODELS_TOKEN`')
    expect(section).not.toContain('ACME_RD_TOKEN')
  })

  it('tells an OPTIONAL credential’s agent to call the integration anyway when it is unset', () => {
    // `required: false` is declared for an endpoint that genuinely works unauthenticated, so the
    // required case's "do not call it at all" is exactly the wrong instruction: it would strand a
    // working integration on the most ordinary misconfiguration there is.
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
        [generator({ credential: { key: 'RD_TOKEN', required: false } })],
      ),
      requestedModalities: [],
    }).join('\n')
    expect(section).toContain('`RD_TOKEN` is OPTIONAL')
    expect(section).toContain('still call the integration, unauthenticated')
    expect(section).not.toContain('do not call `retro-diffusion` at all')
  })

  it('treats an undeclared `required` as REQUIRED, so silence is the safe reading', () => {
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['studio-music'] },
        [music],
      ),
      requestedModalities: [],
    }).join('\n')
    expect(section).toContain('do not call `studio-music` at all')
    expect(section).not.toContain('is OPTIONAL')
  })

  it('injects an integration’s contract under its OWN directory, so no service id can collide', () => {
    // A catalog service may legitimately be called `generator-sprites`, which under a filename
    // prefix would land on exactly the path the integration `sprites` writes. A slug cannot
    // contain `/`, so the directory makes that structurally impossible.
    expect(binaryGeneratorContextFileFor('sprites')).toBe('binary-output/generators/sprites.md')
    expect(binaryGeneratorContextFileFor('sprites')).not.toBe(
      binaryContextFileFor('generator-sprites'),
    )
  })

  it('states an unresolved id and an uncovered content type rather than omitting them', () => {
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['retro-diffusion', 'ghost-synth'],
          modalities: ['image', 'video'],
        },
        [generator()],
      ),
      requestedModalities: ['image', 'video'],
    }).join('\n')
    expect(section).toContain('`ghost-synth`')
    expect(section).toContain('does not register')
    expect(section).toContain('No available integration produces video')
  })

  it('names an OVERLAP, because the per-content-type routing rule stops deciding there', () => {
    // Two producers of one kind is not a misconfiguration, it is the case that motivates
    // selecting two. What it costs is a decision nobody stated, and an agent resolves an unstated
    // choice by picking one and picking it consistently, invisibly, since every artifact has the
    // right modality, the right format and a clean storage verdict.
    const flux = generator({
      id: 'flux',
      name: 'FLUX',
      summary: 'General image generation.',
      modalities: ['image'],
      mediaTypes: ['image/jpeg'],
    })
    const lines = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion', 'flux'] },
        [generator(), flux],
      ),
      requestedModalities: [],
    })
    const section = lines.join('\n')
    expect(section).toContain('`retro-diffusion` and `flux` both produce images.')
    expect(section).toContain('They are not interchangeable.')
    expect(section).toContain('`generator` field')
    // Stated, never RANKED: the platform has no cost model, no quality model and no view of what
    // the step is for, and a confident wrong preference displaces the notes above it. Asserted
    // against the PARAGRAPH rather than the whole section, which also carries each integration's
    // own description, prose a deployment writes and where "prefer" is its author's word to use.
    const paragraph = lines
      .slice(
        lines.findIndex((line) => line.startsWith('More than one of these integrations')),
        lines.findIndex((line) => line.includes('so the choice is on the record.')) + 1,
      )
      .join('\n')
    expect(paragraph).toContain('both produce images.')
    expect(paragraph).not.toMatch(/prefer|instead of `/i)
    // After the per-integration entries, so "the notes above" is literally true.
    expect(section.indexOf('They are not interchangeable.')).toBeGreaterThan(
      section.indexOf('Good for sprites and tiles'),
    )
  })

  it('says nothing about an overlap that does not exist, and none about a repeated id', () => {
    // A paragraph riding every brief is one agents stop reading, and a step that happened to name
    // one integration twice holds one producer, not two.
    const quiet = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion', 'studio-music'] },
        [generator(), music],
      ),
      requestedModalities: [],
    }).join('\n')
    const repeated = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion', 'retro-diffusion'] },
        [generator()],
      ),
      requestedModalities: [],
    }).join('\n')
    expect(quiet).not.toContain('not interchangeable')
    expect(repeated).not.toContain('not interchangeable')
    // And the entry itself is rendered once: two identical entries tell an agent nothing and are
    // charged for like anything else in the brief.
    expect(repeated.match(/### `retro-diffusion`/g)).toHaveLength(1)
  })

  it('names the overlap even when NEITHER shared content type is the deliverable', () => {
    // The step that most needs this is the one generating concept art to feed a mesh API's image
    // path: it declares `3d-model` and holds two image producers. Gating the paragraph on the
    // step's requirements would go silent on exactly that step.
    const flux = generator({ id: 'flux', name: 'FLUX', modalities: ['image'] })
    const meshy = generator({ id: 'meshy', name: 'Meshy', modalities: ['3d-model'] })
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion', 'flux', 'meshy'] },
        [generator(), flux, meshy],
      ),
      requestedModalities: ['3d-model'],
    }).join('\n')
    expect(section).toContain('`retro-diffusion` and `flux` both produce images.')
  })

  it('states an EMPTY selection as its own case, not as silence', () => {
    const section = renderBinaryGeneratorSection({
      selection: { selected: [], unresolvedIds: [] },
      requestedModalities: [],
    }).join('\n')
    expect(section).toContain('No generative integration is configured')
    expect(section).toContain('Do not call an outside generation API')
  })

  it('names the exact formats to request, since the agent is what chooses the container', () => {
    const meshy = generator({
      id: 'meshy',
      modalities: ['3d-model'],
      mediaTypes: ['model/gltf-binary'],
    })
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['meshy'],
          mediaTypes: ['model/gltf-binary'],
        },
        [meshy],
      ),
      requestedModalities: ['3d-model'],
      requestedMediaTypes: ['model/gltf-binary'],
    }).join('\n')
    // The content type is spelled out for the agent, scope included: "3D models" alone would
    // leave a prop generator sounding like it could be asked for the whole environment.
    expect(section).toContain('This step is expected to deliver: 3D models (one asset each).')
    expect(section).toContain('`model/gltf-binary`')
    expect(section).toContain('do not substitute another container')
  })

  it('keeps “nobody could check this” apart from “nothing produces it”', () => {
    // Told nothing, the agent proceeds as if the format were confirmed; told "no integration
    // produces it", it reports a gap that may not exist and skips work it could have done.
    const undeclared = generator({ id: 'mystery-3d', modalities: ['3d-model'], mediaTypes: [] })
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['mystery-3d'] },
        [undeclared],
      ),
      requestedModalities: [],
      requestedMediaTypes: ['model/fbx'],
    }).join('\n')
    expect(section).toContain('unknown rather than settled either way')
    expect(section).not.toContain('No available integration declares that it emits')
  })

  it('states a format requirement even when the step declares no content type', () => {
    // The two lists are independent statements: a step may pin the container without restating
    // the modality, and the requirement block must not disappear with the coarser half.
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
        [generator()],
      ),
      requestedModalities: [],
      requestedMediaTypes: ['image/png'],
    }).join('\n')
    expect(section).toContain('`image/png`')
    expect(section).not.toContain('This step is expected to deliver:')
  })

  it('points at the injected contract file when the integration registers one', () => {
    const withContract = generator({
      contracts: [
        {
          contractId: 'api',
          format: 'openapi',
          title: 'Inference API',
          size: 10,
          path: null,
          operations: ['POST /inferences'],
          omittedOperations: 0,
        },
      ],
    })
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
        [withContract],
      ),
      requestedModalities: [],
    }).join('\n')
    expect(section).toContain(`.cat-context/${binaryGeneratorContextFileFor('retro-diffusion')}`)
  })
})

describe('dispatchBinaryGenerators', () => {
  it('projects only what the executor needs, and never a credential VALUE', () => {
    const refs = dispatchBinaryGenerators(
      resolveBinaryGeneratorSelection(
        {
          storageServiceId: 'asset-store',
          generatorIds: ['retro-diffusion', 'studio-music', 'ghost-synth'],
        },
        [generator(), music],
      ),
    )
    expect(refs).toEqual([
      {
        id: 'retro-diffusion',
        label: 'Retro Diffusion',
        modalities: ['image'],
        credentialKey: 'RD_TOKEN',
      },
      {
        id: 'studio-music',
        label: 'Studio Music',
        modalities: ['audio'],
        credentialKey: 'STUDIO_KEY',
      },
    ])
    // An unresolved id contributes nothing here: it is the BRIEF that says what to do about one,
    // and a half-built entry would look to the executor like something to authenticate.
    expect(refs.some((ref) => ref.id === 'ghost-synth')).toBe(false)
  })
})

describe('renderBinaryOutputBrief with generators', () => {
  it('leads with what MAKES the artifacts, then scope, then where they go', () => {
    const brief = renderBinaryOutputBrief({
      config: {
        storageServiceId: 'asset-store',
        generatorIds: ['retro-diffusion'],
        modalities: ['image'],
      },
      storage: {
        id: 'asset-store',
        name: 'Asset store',
        summary: 'Stores product media.',
        description: '',
        capabilities: ['asset-storage'],
        contracts: [],
      },
      contextServices: [],
      unresolvedContextIds: [],
      generators: resolveBinaryGeneratorSelection(
        { storageServiceId: 'asset-store', generatorIds: ['retro-diffusion'] },
        [generator()],
      ),
    })
    expect(brief.indexOf('## Generation')).toBeLessThan(brief.indexOf('## Scope'))
    expect(brief.indexOf('## Scope')).toBeLessThan(brief.indexOf('## Storage'))
    expect(brief).toContain('`retro-diffusion`')
    expect(brief).toContain('`asset-store`')
  })
})
