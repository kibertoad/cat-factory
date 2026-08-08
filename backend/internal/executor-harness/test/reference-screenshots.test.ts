import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAgentJob } from '../src/job.js'
import {
  REFERENCE_SCREENSHOT_DIR,
  materializeReferenceScreenshots,
  referenceScreenshotGuidance,
} from '../src/reference-screenshots.js'

// The reference designs a capturing run is handed: parsed defensively at the job boundary, then
// downloaded into the checkout. The rules under test are the ones a silent bug would hide: a
// hostile file name escaping the context directory, and a reference that failed to arrive looking
// exactly like a screen the design does not have.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refs-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const BASE_JOB = {
  jobId: 'job_1',
  mode: 'explore',
  systemPrompt: 'sp',
  userPrompt: 'up',
  model: 'm',
  ghToken: 'gh',
  branch: 'main',
  proxyBaseUrl: 'https://proxy.test/v1',
  sessionToken: 'tok',
  repo: {
    owner: 'acme',
    name: 'widgets',
    baseBranch: 'main',
    cloneUrl: 'https://github.com/acme/widgets.git',
  },
}

function parse(referenceScreenshots: unknown) {
  return parseAgentJob({ ...BASE_JOB, referenceScreenshots }).referenceScreenshots
}

describe('reference-design manifest parsing', () => {
  it('keeps a well-formed manifest, trimming the base URL', () => {
    expect(
      parse({
        url: 'https://proxy.test/v1/artifacts/reference/',
        token: 'session',
        files: [{ artifactId: 'art_1', fileName: 'Checkout.png', view: 'Checkout' }],
      }),
    ).toEqual({
      url: 'https://proxy.test/v1/artifacts/reference',
      token: 'session',
      files: [{ artifactId: 'art_1', fileName: 'Checkout.png', view: 'Checkout' }],
    })
  })

  it('drops the WHOLE manifest when its transport half is unusable', () => {
    const files = [{ artifactId: 'art_1', fileName: 'a.png', view: 'A' }]

    // Every file would fail the same way, and one stated cause beats N identical ones.
    expect(parse({ url: 'https://proxy.test/v1/artifacts/reference', files })).toBeUndefined()
    expect(parse({ url: 'ftp://proxy.test/refs', token: 't', files })).toBeUndefined()
    expect(parse({ token: 't', files })).toBeUndefined()
  })

  it('refuses a file name that would escape the context directory', () => {
    const manifest = parse({
      url: 'https://proxy.test/v1/artifacts/reference',
      token: 't',
      files: [
        { artifactId: 'art_1', fileName: '../../etc/passwd', view: 'Escape' },
        { artifactId: 'art_2', fileName: 'ok.png', view: 'Fine' },
      ],
    })

    // Sanitised to a basename by the same rule every context file gets: the traversal collapses
    // to a plain name inside the directory rather than reaching a repo file.
    expect(manifest?.files.map((f) => f.fileName)).toEqual(['passwd', 'ok.png'])
  })

  it('refuses an artifact id that is not one the platform could have minted', () => {
    const manifest = parse({
      url: 'https://proxy.test/v1/artifacts/reference',
      token: 't',
      files: [
        { artifactId: '../secrets', fileName: 'a.png', view: 'A' },
        { artifactId: 'art_2', fileName: 'b.png', view: 'B' },
      ],
    })

    // The id becomes a path segment on the download URL.
    expect(manifest?.files.map((f) => f.artifactId)).toEqual(['art_2'])
  })
})

describe('materializeReferenceScreenshots', () => {
  const manifest = {
    url: 'https://proxy.test/v1/artifacts/reference',
    token: 'session',
    files: [
      { artifactId: 'art_1', fileName: 'Checkout.png', view: 'Checkout' },
      { artifactId: 'art_2', fileName: 'Confirm.png', view: 'Confirm' },
    ],
  }

  it('writes each image and authenticates with the run’s own token', async () => {
    const seen: { url: string; auth: string | null }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get('authorization'),
      })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as unknown as typeof fetch

    const outcome = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    expect(outcome.failed).toEqual([])
    expect(outcome.written).toEqual([
      { fileName: 'Checkout.png', view: 'Checkout' },
      { fileName: 'Confirm.png', view: 'Confirm' },
    ])
    expect(seen.map((call) => call.url).sort()).toEqual([
      'https://proxy.test/v1/artifacts/reference/art_1',
      'https://proxy.test/v1/artifacts/reference/art_2',
    ])
    expect(seen[0]!.auth).toBe('Bearer session')
    const written = await readdir(join(dir, REFERENCE_SCREENSHOT_DIR))
    expect(written.sort()).toEqual(['Checkout.png', 'Confirm.png'])
    expect(
      new Uint8Array(await readFile(join(dir, REFERENCE_SCREENSHOT_DIR, 'Checkout.png'))),
    ).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('NAMES a reference it could not fetch instead of leaving it absent', async () => {
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).endsWith('art_2')
        ? new Response('nope', { status: 404 })
        : new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch

    const outcome = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    // An absent file and a screen the design does not have look identical on disk, so the miss
    // has to be carried out and stated in the prompt.
    expect(outcome.written).toEqual([{ fileName: 'Checkout.png', view: 'Checkout' }])
    expect(outcome.failed).toEqual([{ view: 'Confirm', reason: 'HTTP 404' }])
    expect(await readdir(join(dir, REFERENCE_SCREENSHOT_DIR))).toEqual(['Checkout.png'])
  })

  it('treats an empty body as a miss rather than writing a blank image', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([]), { status: 200 })) as unknown as typeof fetch

    const outcome = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    expect(outcome.written).toEqual([])
    expect(outcome.failed.map((f) => f.reason)).toEqual(['empty response', 'empty response'])
  })

  it('never throws when the transport is down', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch

    const outcome = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    // References aid a comparison; they are not a precondition for running.
    expect(outcome.written).toEqual([])
    expect(outcome.failed).toHaveLength(2)
  })
})

describe('referenceScreenshotGuidance', () => {
  it('lists what landed and, separately, what did not', () => {
    const guidance = referenceScreenshotGuidance({
      dir: REFERENCE_SCREENSHOT_DIR,
      written: [{ fileName: 'Checkout.png', view: 'Checkout' }],
      failed: [{ view: 'Confirm', reason: 'HTTP 404' }],
    })

    expect(guidance).toContain('.cat-context/reference-screenshots/Checkout.png`: Checkout')
    // The agent must still capture the view under that name: the gate pairs on the name, and a
    // view it never hears about is one nobody can compare later either.
    expect(guidance).toContain('Confirm: NOT on disk (HTTP 404)')
  })

  it('says nothing at all when the run was handed no references', () => {
    expect(
      referenceScreenshotGuidance({ dir: REFERENCE_SCREENSHOT_DIR, written: [], failed: [] }),
    ).toBe('')
  })
})
