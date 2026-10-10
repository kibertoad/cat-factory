import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESIGN_RENDER_DIR,
  designImageGuidance,
  materializeDesignImages,
} from '../src/design-images.js'
import type { ImageManifestSpec } from '../src/job.js'

function manifest(over: Partial<ImageManifestSpec> = {}): ImageManifestSpec {
  return {
    url: 'https://proxy.example.com/v1/artifacts/reference',
    token: 'sess',
    files: [{ artifactId: 'art_1', fileName: 'Checkout.png', view: 'Checkout' }],
    omitted: [],
    ...over,
  }
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'design-images-'))
}

describe('materializeDesignImages', () => {
  it('writes each picture into its OWN directory, apart from the capture set', async () => {
    const dir = await workspace()
    const outcome = await materializeDesignImages(dir, manifest(), {
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])),
    })
    expect(outcome.dir).toBe(DESIGN_RENDER_DIR)
    expect(await readdir(join(dir, DESIGN_RENDER_DIR))).toEqual(['Checkout.png'])
    expect(await readFile(join(dir, DESIGN_RENDER_DIR, 'Checkout.png'))).toEqual(
      Buffer.from([1, 2, 3]),
    )
    expect(outcome.missing).toEqual([])
  })

  it('sends the run session token and nothing else', async () => {
    const dir = await workspace()
    let seen: Headers | undefined
    await materializeDesignImages(dir, manifest(), {
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers)
        return new Response(new Uint8Array([1]))
      },
    })
    expect(seen?.get('authorization')).toBe('Bearer sess')
  })

  it('reports a picture that did not transfer', async () => {
    const dir = await workspace()
    const outcome = await materializeDesignImages(dir, manifest(), {
      fetchImpl: async () => new Response('nope', { status: 404 }),
    })
    expect(outcome.written).toEqual([])
    expect(outcome.missing).toEqual([{ view: 'Checkout', reason: 'HTTP 404' }])
  })
})

describe('designImageGuidance', () => {
  it('says NOTHING when the container matches what the prompt promised', () => {
    // The backend's prompt already names every picture and its view; a second list that agrees
    // would just be two lists of the same files, differing only when something went wrong.
    expect(
      designImageGuidance({ written: [{ fileName: 'a.png', view: 'A' }], missing: [], dir: 'd' }),
    ).toBe('')
    expect(designImageGuidance({ written: [], missing: [], dir: 'd' })).toBe('')
  })

  it('corrects the prompt for a picture that is not here, naming the cause', () => {
    // An agent told to open a file that is not there re-reads the path and eventually decides the
    // design is missing something, when one picture simply failed to transfer.
    const guidance = designImageGuidance({
      written: [],
      missing: [{ view: 'Checkout', reason: 'HTTP 404' }],
      dir: 'd',
    })
    expect(guidance).toContain('Checkout')
    expect(guidance).toContain('HTTP 404')
    expect(guidance).toContain('design description')
  })
})
