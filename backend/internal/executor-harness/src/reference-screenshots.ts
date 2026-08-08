import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReferenceScreenshotSpec, ReferenceScreenshotsSpec } from './job.js'
import type { Logger } from './logger.js'
import { CONTEXT_DIR, excludeContextDir } from './pi.js'

// ---------------------------------------------------------------------------
// REFERENCE DESIGNS on disk: download the images the backend resolved for this task into
// `.cat-context/reference-screenshots/`, the directory the UI-tester prompt has always named and
// nothing wrote.
//
// The harness MATERIALISES and never decides: which artifact is the reference for which view, and
// what each file is called, are backend answers that ride the job body. What lives here is the
// transfer and its failure reporting: a reference the container could not fetch is NAMED to the
// agent rather than silently missing, because an absent file and a design that has no such screen
// look identical on disk.
// ---------------------------------------------------------------------------

/** Subdirectory of {@link CONTEXT_DIR} the reference designs are written to. */
export const REFERENCE_SCREENSHOT_SUBDIR = 'reference-screenshots'

/** Per-image ceiling, matching the platform's own upload ceiling (16 MiB). */
const MAX_REFERENCE_BYTES = 16 * 1024 * 1024

/** Per-image request timeout. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Wall-clock ceiling on the WHOLE pass.
 *
 * Downloading is activity-silent from the watchdog's point of view (no agent stream, no output),
 * and `JOB_INACTIVITY_MS` (10 min) is what kills a job that stops producing. Rather than heartbeat
 * a transfer that should take seconds, the pass is bounded far below that: a slow or wedged blob
 * backend costs the run its references (stated to the agent) instead of costing it the run.
 */
const TOTAL_BUDGET_MS = 90_000

/** How many images are fetched at once. Small on purpose: this is a shared blob backend. */
const CONCURRENCY = 4

/** The cause reported for a view the backend resolved but never sent this job a file for. */
const OMITTED_REASON = 'not sent to this container (reference limit)'

/** What the pass has on disk, and what it does not. */
export interface ReferenceScreenshotOutcome {
  written: { fileName: string; view: string }[]
  /**
   * One entry per reference that is NOT on disk, with the cause stated in `reason`. Covers both
   * halves of that absence, because the agent's job is the same either way (capture the view under
   * its own name, with nothing to compare against): a transfer that failed, and a view the cap
   * dropped before this container was ever asked to fetch it.
   */
  missing: { view: string; reason: string }[]
  /** Where the written files live, relative to the checkout root. */
  dir: string
}

/** The relative directory the references are written to (what the prompt points the agent at). */
export const REFERENCE_SCREENSHOT_DIR = `${CONTEXT_DIR}/${REFERENCE_SCREENSHOT_SUBDIR}`

/**
 * Download the manifest's images into the checkout and report what landed.
 *
 * IDEMPOTENT, and that is load-bearing rather than an optimisation: an agent flow re-enters its
 * workspace once per repair round, so this pass runs several times over one checkout. A file
 * already on disk is counted and never re-fetched, which keeps a later round from spending the
 * budget again AND from reporting a view as absent that pass 1 successfully delivered. A view that
 * MISSED is retried, since the next round is a fresh chance at whatever was transiently down.
 *
 * Never throws: references are an aid to a comparison, not a precondition for running, so a
 * backend outage degrades a UI run to "name your own views" (the documented fallback) rather than
 * failing it. Every miss is carried out on {@link ReferenceScreenshotOutcome.missing} so the caller
 * can say so in the prompt, which is the difference between a design the platform failed to hand
 * over and one that has no such screen.
 */
export async function materializeReferenceScreenshots(
  cwd: string,
  spec: ReferenceScreenshotsSpec,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<ReferenceScreenshotOutcome> {
  const dir = join(cwd, CONTEXT_DIR, REFERENCE_SCREENSHOT_SUBDIR)
  const outcome: ReferenceScreenshotOutcome = {
    written: [],
    // The backend's own dropped views are missing before a single byte is fetched, and for a cause
    // no transfer could have changed.
    missing: spec.omitted.map((view) => ({ view, reason: OMITTED_REASON })),
    dir: REFERENCE_SCREENSHOT_DIR,
  }
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    // Nowhere to write: report every reference as missed rather than half of them, since none of
    // them can land and the cause is the same for all.
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
        outcome.missing.push({ view: file.view, reason: 'reference download budget exhausted' })
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
  outcome: ReferenceScreenshotOutcome,
  spec: ReferenceScreenshotsSpec,
): ReferenceScreenshotOutcome {
  const rank = new Map(spec.files.map((file, index) => [file.view, index] as const))
  const at = (view: string) => rank.get(view) ?? Number.MAX_SAFE_INTEGER
  outcome.written.sort((a, b) => at(a.view) - at(b.view))
  outcome.missing.sort((a, b) => at(a.view) - at(b.view))
  return outcome
}

/**
 * Whether a previous pass over this checkout already wrote this reference.
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

/**
 * The whole delivery in one call: download the manifest (when there is one) and answer the prompt
 * block naming what landed, reporting any miss to the operator on the way.
 *
 * One entry point so an agent-running flow cannot end up doing half of it. A miss is stated to the
 * AGENT in its prompt (it still has to capture that view) AND logged here, because a reference that
 * never arrives is otherwise invisible in the run's output: the gallery simply pairs against
 * nothing, months later, with no line anywhere saying why.
 */
export async function deliverReferenceScreenshots(
  cwd: string,
  spec: ReferenceScreenshotsSpec | undefined,
  options: { signal?: AbortSignal; log: Logger; fetchImpl?: typeof fetch },
): Promise<string> {
  if (!spec) return ''
  const outcome = await materializeReferenceScreenshots(cwd, spec, options)
  if (outcome.missing.length) {
    options.log.warn('agent: some reference designs are not on disk', {
      written: outcome.written.length,
      missing: outcome.missing.length,
      reasons: outcome.missing.map((file) => file.reason).slice(0, 5),
    })
  }
  return referenceScreenshotGuidance(outcome)
}

/** Fetch and write one reference, answering a failure reason or undefined on success. */
async function downloadOne(
  dir: string,
  spec: ReferenceScreenshotsSpec,
  file: ReferenceScreenshotSpec,
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
    const bytes = await readBounded(response, MAX_REFERENCE_BYTES)
    if (bytes === 'too-large') return 'reference exceeds size limit'
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

/**
 * The prompt block naming what the agent was handed, or '' when the pass produced nothing at all.
 *
 * States the MISSES beside the files, because the whole point of writing this directory is that
 * the tester captures the same views the gate will pair against: a reference that did not arrive
 * is a view the agent should still capture (under that name) rather than one that does not exist.
 *
 * The "on disk" sentence is bound to the files that ARE on disk, and appears only with them. A
 * block that asserts a populated directory when the pass wrote nothing (every transfer failed, or
 * the directory could not be created at all) sends the agent looking for a path that may not even
 * exist, and reads as a platform bug at exactly the moment the platform is already degraded.
 */
export function referenceScreenshotGuidance(outcome: ReferenceScreenshotOutcome): string {
  if (!outcome.written.length && !outcome.missing.length) return ''
  const onDisk = outcome.written.length
    ? `\n\nThese are on disk, one file per view:\n${outcome.written
        .map((file) => `- \`${outcome.dir}/${file.fileName}\`: ${file.view}`)
        .join('\n')}`
    : ''
  const absent = outcome.missing.length
    ? `\n\nThese views have NO reference image in this container, for the reason given. Capture them
anyway, under exactly these names. There is simply nothing here to compare against:\n${outcome.missing
        .map((file) => `- ${file.view}: NOT on disk (${file.reason})`)
        .join('\n')}`
    : ''
  return `

## Reference designs (capture these views)
Capture the views named below and name each screenshot's \`view\` EXACTLY as given, so the platform
can pair your capture with its reference. Capture any other view the task needs under a name of
your own.${onDisk}${absent}`
}
