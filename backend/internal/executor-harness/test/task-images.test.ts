import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESIGN_RENDER_DIR } from '../src/design-images.js'
import { deliverJobImages } from '../src/job-images.js'
import type { ImageManifestSpec } from '../src/job.js'
import type { Logger } from '../src/logger.js'
import { TASK_IMAGE_DIR } from '../src/task-images.js'

const silent = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as never as Logger

function manifest(fileName: string, view: string): ImageManifestSpec {
  return {
    url: 'https://proxy.example.com/v1/artifacts/reference',
    token: 'sess',
    files: [{ artifactId: `art_${fileName}`, fileName, view }],
    omitted: [],
  }
}

describe('task image delivery', () => {
  it('writes the attached images apart from the design pictures and says nothing on success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-images-'))
    const guidance = await deliverJobImages(
      {
        dir,
        designImages: manifest('Checkout.png', 'Checkout'),
        taskImages: manifest('crash.png', 'crash.png'),
      },
      { log: silent, fetchImpl: async () => new Response(new Uint8Array([1])) },
    )
    expect(guidance).toBe('')
    expect(await readdir(join(dir, TASK_IMAGE_DIR))).toEqual(['crash.png'])
    expect(await readdir(join(dir, DESIGN_RENDER_DIR))).toEqual(['Checkout.png'])
  })

  it('corrects the prompt for an attached image that did not transfer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-images-'))
    const guidance = await deliverJobImages(
      { dir, taskImages: manifest('crash.png', 'crash.png') },
      { log: silent, fetchImpl: async () => new Response('nope', { status: 404 }) },
    )
    expect(guidance).toContain('Images attached to this task: correction')
    expect(guidance).toContain('crash.png: NOT on disk (HTTP 404)')
  })
})
