import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
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
// hostile file name escaping the context directory, a reference that failed to arrive looking
// exactly like a screen the design does not have, and a set the platform CAPPED looking like a
// task that simply holds fewer references than it does.

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
      omitted: [],
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

  it('carries the views the BACKEND capped, so a dropped one is still named', () => {
    const manifest = parse({
      url: 'https://proxy.test/v1/artifacts/reference',
      token: 't',
      files: [{ artifactId: 'art_1', fileName: 'a.png', view: 'A' }],
      omitted: ['Settings', 'Profile', 7],
    })

    expect(manifest?.omitted).toEqual(['Settings', 'Profile'])
  })

  it('NAMES what its own backstop drops instead of truncating in silence', () => {
    const files = Array.from({ length: 45 }, (_, n) => ({
      artifactId: `art${n}`,
      fileName: `view-${n}.png`,
      view: `View ${n}`,
    }))

    const manifest = parse({ url: 'https://proxy.test/v1/artifacts/reference', token: 't', files })

    // The ceiling still binds on what is FETCHED...
    expect(manifest?.files).toHaveLength(40)
    // ...but an entry past it is a view the agent must still capture, not one it never hears of.
    expect(manifest?.omitted).toEqual(['View 40', 'View 41', 'View 42', 'View 43', 'View 44'])
  })

  it('keeps a manifest that is nothing BUT capped views', () => {
    // Every file dropped and nothing fetchable is still something to say: the agent is told which
    // views to capture. Only a manifest with neither half is dropped entirely.
    expect(
      parse({
        url: 'https://proxy.test/v1/artifacts/reference',
        token: 't',
        files: [],
        omitted: ['Settings'],
      })?.omitted,
    ).toEqual(['Settings'])
    expect(
      parse({ url: 'https://proxy.test/v1/artifacts/reference', token: 't', files: [] }),
    ).toBeUndefined()
  })
})

describe('materializeReferenceScreenshots', () => {
  const manifest = {
    url: 'https://proxy.test/v1/artifacts/reference',
    token: 'session',
    omitted: [],
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

    expect(outcome.missing).toEqual([])
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
    expect(outcome.missing).toEqual([{ view: 'Confirm', reason: 'HTTP 404' }])
    expect(await readdir(join(dir, REFERENCE_SCREENSHOT_DIR))).toEqual(['Checkout.png'])
  })

  it('reports a view the BACKEND capped as missing before any transfer', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch

    const outcome = await materializeReferenceScreenshots(
      dir,
      { ...manifest, omitted: ['Settings'] },
      { fetchImpl },
    )

    expect(outcome.written).toHaveLength(2)
    // A cap the agent is not told about is indistinguishable from a design with no such screen.
    expect(outcome.missing).toEqual([
      { view: 'Settings', reason: 'not sent to this container (reference limit)' },
    ])
  })

  it('treats an empty body as a miss rather than writing a blank image', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([]), { status: 200 })) as unknown as typeof fetch

    const outcome = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    expect(outcome.written).toEqual([])
    expect(outcome.missing.map((f) => f.reason)).toEqual(['empty response', 'empty response'])
  })

  it('never throws when the transport is down', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch

    const outcome = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    // References aid a comparison; they are not a precondition for running.
    expect(outcome.written).toEqual([])
    expect(outcome.missing).toHaveLength(2)
  })

  it('refuses an oversized body WITHOUT buffering all of it', async () => {
    // A body that never ends: buffering before measuring would run the container out of memory
    // rather than report a reference that is too big.
    let produced = 0
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            produced += 1024 * 1024
            controller.enqueue(new Uint8Array(1024 * 1024))
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const outcome = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    expect(outcome.written).toEqual([])
    expect(outcome.missing.map((f) => f.reason)).toEqual([
      'reference exceeds size limit',
      'reference exceeds size limit',
    ])
    // The stream is cancelled as it crosses the line rather than drained: a hard bound on what an
    // endless body can cost, per image and across the pass's concurrency.
    expect(produced).toBeLessThan(2 * 2 * 16 * 1024 * 1024)
  })

  it('refuses a DECLARED oversized length without streaming the body', async () => {
    // Same endless body as above, but this one announces its size. The declared length is the
    // cheap half of the bound: an honest sender is refused before a byte is counted, so what the
    // stream goes on to produce is the difference between the two paths.
    let produced = 0
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            produced += 1024 * 1024
            controller.enqueue(new Uint8Array(1024 * 1024))
          },
        }),
        { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } },
      )) as unknown as typeof fetch

    const outcome = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    expect(outcome.missing.map((f) => f.reason)).toEqual([
      'reference exceeds size limit',
      'reference exceeds size limit',
    ])
    // Counting to the 16 MiB ceiling would take sixteen chunks per image; the stream is left
    // where its own construction parked it instead.
    expect(produced).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  it('re-uses what an earlier pass delivered instead of downloading it again', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as unknown as typeof fetch

    const first = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })
    const second = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    // An agent flow re-enters its workspace once per repair round. The second pass must cost no
    // transfers and must not downgrade a view pass 1 delivered to "NOT on disk".
    expect(calls).toBe(2)
    expect(second.written).toEqual(first.written)
    expect(second.missing).toEqual([])
  })

  it('RETRIES a view an earlier pass missed', async () => {
    let attempt = 0
    const fetchImpl = (async (url: string | URL | Request) => {
      if (!String(url).endsWith('art_2')) return new Response(new Uint8Array([1]), { status: 200 })
      attempt += 1
      return attempt === 1
        ? new Response('nope', { status: 503 })
        : new Response(new Uint8Array([9]), { status: 200 })
    }) as unknown as typeof fetch

    const first = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })
    const second = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    expect(first.missing).toEqual([{ view: 'Confirm', reason: 'HTTP 503' }])
    // A later round is a fresh chance at whatever was transiently down.
    expect(second.missing).toEqual([])
    expect(second.written).toHaveLength(2)
  })

  it('does not count a half-written zero-length file as delivered', async () => {
    await mkdir(join(dir, REFERENCE_SCREENSHOT_DIR), { recursive: true })
    await writeFile(join(dir, REFERENCE_SCREENSHOT_DIR, 'Checkout.png'), new Uint8Array([]))
    const fetchImpl = (async () =>
      new Response(new Uint8Array([7]), { status: 200 })) as unknown as typeof fetch

    const outcome = await materializeReferenceScreenshots(dir, manifest, { fetchImpl })

    // A blank image reads to the agent as a design with nothing on the screen, so it is re-fetched
    // rather than trusted.
    expect(outcome.written).toHaveLength(2)
    expect(
      new Uint8Array(await readFile(join(dir, REFERENCE_SCREENSHOT_DIR, 'Checkout.png'))),
    ).toEqual(new Uint8Array([7]))
  })
})

describe('referenceScreenshotGuidance', () => {
  it('lists what landed and, separately, what did not', () => {
    const guidance = referenceScreenshotGuidance({
      dir: REFERENCE_SCREENSHOT_DIR,
      written: [{ fileName: 'Checkout.png', view: 'Checkout' }],
      missing: [{ view: 'Confirm', reason: 'HTTP 404' }],
    })

    expect(guidance).toContain('.cat-context/reference-screenshots/Checkout.png`: Checkout')
    // The agent must still capture the view under that name: the gate pairs on the name, and a
    // view it never hears about is one nobody can compare later either.
    expect(guidance).toContain('Confirm: NOT on disk (HTTP 404)')
  })

  it('never claims a populated directory when nothing landed', () => {
    const guidance = referenceScreenshotGuidance({
      dir: REFERENCE_SCREENSHOT_DIR,
      written: [],
      missing: [{ view: 'Confirm', reason: 'EACCES: permission denied' }],
    })

    // The mkdir-failure branch leaves no directory at all, so asserting one sends the agent after
    // a path that does not exist at the moment the platform is already degraded.
    expect(guidance).not.toContain('are on disk')
    expect(guidance).toContain('Confirm: NOT on disk (EACCES: permission denied)')
  })

  it('says nothing at all when the run was handed no references', () => {
    expect(
      referenceScreenshotGuidance({ dir: REFERENCE_SCREENSHOT_DIR, written: [], missing: [] }),
    ).toBe('')
  })
})
