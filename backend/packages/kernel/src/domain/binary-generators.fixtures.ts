import type { BinaryGeneratorView } from './binary-generator-registry.js'

// The one `BinaryGeneratorView` factory the binary-output test files share.
//
// Its own module rather than a copy beside each suite, because two of the three are SIBLINGS of
// one split file: a local `generator` in each half would let the same name mean different defaults
// depending on which half you are reading, which is exactly the confusion a reader of a split file
// does not expect to have to check for.
//
// The defaults are what `BinaryGeneratorRegistry` can actually PROJECT. `capabilities`,
// `mediaTypes`, `contracts` and `credentials` are built there as `[...(definition.x ?? [])]`, so
// they are arrays on every view a reader is ever handed and a test overriding one with `undefined`
// would be pinning a shape the registry cannot produce.
//
// Out of the build, the mutation scope and the coverage denominator (see this package's
// `tsconfig.build.json`, `stryker.config.mjs` and `vitest.config.ts`): it is test scaffolding, and
// a fixture's own string literals are not behaviour anything should be asked to pin.
export function generator(overrides: Partial<BinaryGeneratorView> = {}): BinaryGeneratorView {
  return {
    id: 'retro-diffusion',
    name: 'Retro Diffusion',
    summary: 'Pixel-art image generation.',
    description: 'Good for sprites and tiles; not for photorealism.',
    modalities: ['image'],
    mediaTypes: ['image/png'],
    capabilities: [],
    endpoint: 'https://api.retrodiffusion.ai/v1',
    credentials: [{ key: 'RD_TOKEN', usage: 'the X-RD-Token request header' }],
    contracts: [],
    ...overrides,
  }
}
