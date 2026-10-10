import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageFileSpec, ImageManifestSpec } from './job.js'
import { CONTEXT_DIR, excludeContextDir } from './pi.js'

// ---------------------------------------------------------------------------
// The TRANSFER half of every image manifest: download the images the backend resolved for this job
// into a subdirectory of `.cat-context/`, and report what did not land.
//
// Shared by both manifests (the capture references and the design pictures) because the transfer is
// the same in every respect that matters here: the same download seam, the same per-image and
// whole-pass budgets, the same idempotence over a checkout an agent flow re-enters once per repair
// round, and the same rule that a miss is NAMED rather than silently absent. What differs is what
// the files mean, which is why each caller owns its own directory and its own prompt block.
//
// The harness MATERIALISES and never decides: which artifact belongs to which view, and what each
// file is called, are backend answers that ride the job body.
// ---------------------------------------------------------------------------

/** Per-image ceiling, matching the platform's own upload ceiling (16 MiB). */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024

/** Per-image request timeout. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Wall-clock ceiling on the WHOLE pass.
 *
 * Downloading is activity-silent from the watchdog's point of view (no agent stream, no output),
 * and `JOB_INACTIVITY_MS` (10 min) is what kills a job that stops producing. Rather than heartbeat
 * a transfer that should take seconds, the pass is bounded far below that: a slow or wedged blob
 * backend costs the run its images (stated to the agent) instead of costing it the run.
 *
 * Bounds ONE pass, and a job with both manifests runs two. That is deliberate: the alternative is a
 * shared budget in which whichever manifest is delivered first can starve the other, which would
 * make a capture's references depend on how many design pictures the same task happens to hold.
 */
const TOTAL_BUDGET_MS = 90_000

/** How many images are fetched at once. Small on purpose: this is a shared blob backend. */
const CONCURRENCY = 4

/** What a transfer pass has on disk, and what it does not. */
export interface ContextImageOutcome {
  written: { fileName: string; view: string }[]
  /**
   * One entry per image that is NOT on disk, with the cause stated in `reason`. Covers both halves
   * of that absence, because the agent's position is the same either way (this view exists and
   * there is no picture of it here): a transfer that failed, and a view the backend's own cap
   * dropped before this container was ever asked to fetch it.
   */
  missing: { view: string; reason: string }[]
  /** Where the written files live, relative to the checkout root. */
  dir: string
}

/** The cause reported for a view the backend resolved but never sent this job a file for. */
const OMITTED_REASON = 'not sent to this container (image limit)'

/**
 * Download a manifest's images into `<checkout>/.cat-context/<subdir>/` and report what landed.
 *
 * IDEMPOTENT, and that is load-bearing rather than an optimisation: an agent flow re-enters its
 * workspace once per repair round, so this pass runs several times over one checkout. A file
 * already on disk is counted and never re-fetched, which keeps a later round from spending the
 * budget again AND from reporting an image as absent that pass 1 successfully delivered. A view
 * that MISSED is retried, since the next round is a fresh chance at whatever was transiently down.
 *
 * Never throws: images are an aid, not a precondition for running, so a backend outage degrades the
 * run to its textual context rather than failing it. Every miss is carried out on
 * {@link ContextImageOutcome.missing} so the caller can say so in the prompt, which is the
 * difference between an image the platform failed to hand over and a screen that does not exist.
 */
export async function materializeContextImages(
  cwd: string,
  subdir: string,
  spec: ImageManifestSpec,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<ContextImageOutcome> {
  const dir = join(cwd, CONTEXT_DIR, subdir)
  const outcome: ContextImageOutcome = {
    written: [],
    // The backend's own dropped views are missing before a single byte is fetched, and for a cause
    // no transfer could have changed.
    missing: spec.omitted.map((view) => ({ view, reason: OMITTED_REASON })),
    dir: `${CONTEXT_DIR}/${subdir}`,
  }
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    // Nowhere to write: report every image as missed rather than half of them, since none of them
    // can land and the cause is the same for all.
    for (const file of spec.files)
      outcome.missing.push({ view: file.view, reason: describe(error) })
    return sortByManifest(outcome, spec)
  }
  const deadline = Date.now() + TOTAL_BUDGET_MS
  const queue = [...spec.files]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const file = queue.shift()
      if (!file) return
      // An earlier pass over this same checkout already delivered it. Checked before the budget so
      // a fully-delivered set costs one stat per file and no network at all, however long an
      // earlier round took.
      if (await alreadyOnDisk(dir, file.fileName)) {
        outcome.written.push({ fileName: file.fileName, view: file.view })
        continue
      }
      if (Date.now() >= deadline) {
        outcome.missing.push({ view: file.view, reason: 'image download budget exhausted' })
        continue
      }
      const failure = await downloadOne(dir, spec, file, options)
      if (failure) outcome.missing.push({ view: file.view, reason: failure })
      else outcome.written.push({ fileName: file.fileName, view: file.view })
    }
  })
  await Promise.all(workers)
  // Even a partial set must not reach the agent's PR (same rule as every other context file).
  await excludeContextDir(cwd)
  return sortByManifest(outcome, spec)
}

/**
 * Order both lists the way the BACKEND composed the set (its own gallery order) rather than the
 * order the transfers happened to finish in, so the list the agent reads is stable across rounds.
 * The dropped views trail the sent ones, having no position in the manifest to sort by.
 */
function sortByManifest(
  outcome: ContextImageOutcome,
  spec: ImageManifestSpec,
): ContextImageOutcome {
  const rank = new Map(spec.files.map((file, index) => [file.view, index] as const))
  const at = (view: string) => rank.get(view) ?? Number.MAX_SAFE_INTEGER
  outcome.written.sort((a, b) => at(a.view) - at(b.view))
  outcome.missing.sort((a, b) => at(a.view) - at(b.view))
  return outcome
}

/**
 * Whether a previous pass over this checkout already wrote this image.
 *
 * Non-empty is the test, not mere existence: a zero-length file is what a half-written transfer
 * leaves behind, and treating it as delivered would hand the agent a blank image it reads as a
 * design with nothing on the screen (the same case {@link downloadOne} refuses to write).
 */
async function alreadyOnDisk(dir: string, fileName: string): Promise<boolean> {
  try {
    return (await stat(join(dir, fileName))).size > 0
  } catch {
    // silent-catch-ok: absence is the ordinary answer here (first pass over the checkout), and any
    // other stat failure is answered the same way — by attempting the download.
    return false
  }
}

/** Fetch and write one image, answering a failure reason or undefined on success. */
async function downloadOne(
  dir: string,
  spec: ImageManifestSpec,
  file: ImageFileSpec,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<string | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try {
    const response = await fetchImpl(`${spec.url}/${encodeURIComponent(file.artifactId)}`, {
      headers: { authorization: `Bearer ${spec.token}` },
      signal,
    })
    if (!response.ok) return `HTTP ${response.status}`
    const bytes = await readBounded(response, MAX_IMAGE_BYTES)
    if (bytes === 'too-large') return 'image exceeds size limit'
    // A zero-length body is a miss, not a file: written out it would be an image the agent opens,
    // finds empty, and reads as a design with nothing on the screen.
    if (!bytes.byteLength) return 'empty response'
    await writeFile(join(dir, file.fileName), bytes)
    return undefined
  } catch (error) {
    return describe(error)
  }
}

/**
 * Read a response body, refusing one that goes past `limit` WITHOUT buffering all of it first.
 *
 * The ceiling has to bound the transfer and not just the write. Buffering the whole body and then
 * measuring it means an oversized (or endless) response is already resident, times the pass's
 * concurrency, by the time it is rejected — which is the container's memory, in a run whose whole
 * point is that it has not started working yet. So the declared length is refused up front where
 * it is honest, and the stream is counted as it arrives and cancelled the moment it crosses the
 * line, which is what makes a chunked or lying body cost no more than a truthful one.
 */
async function readBounded(response: Response, limit: number): Promise<Uint8Array | 'too-large'> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return 'too-large'
  const body = response.body
  if (!body) {
    // No stream to count (a mocked or already-buffered response): fall back to measuring after the
    // fact, which is sound because there is nothing left to stop arriving.
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > limit ? 'too-large' : bytes
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        return 'too-large'
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** A one-line cause for a failed transfer (never the token, which only rides a header). */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
