import { mkdir, writeFile } from 'node:fs/promises'
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

/** What the pass wrote, and what it could not. */
export interface ReferenceScreenshotOutcome {
  written: { fileName: string; view: string }[]
  /** One entry per reference that could not be written, with the cause stated in `reason`. */
  failed: { view: string; reason: string }[]
  /** Where the written files live, relative to the checkout root. */
  dir: string
}

/** The relative directory the references are written to (what the prompt points the agent at). */
export const REFERENCE_SCREENSHOT_DIR = `${CONTEXT_DIR}/${REFERENCE_SCREENSHOT_SUBDIR}`

/**
 * Download the manifest's images into the checkout and report what landed.
 *
 * Never throws: references are an aid to a comparison, not a precondition for running, so a
 * backend outage degrades a UI run to "name your own views" (the documented fallback) rather than
 * failing it. Every miss is carried out on {@link ReferenceScreenshotOutcome.failed} so the caller
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
    failed: [],
    dir: REFERENCE_SCREENSHOT_DIR,
  }
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    // Nowhere to write: report every reference as missed rather than half of them, since none of
    // them can land and the cause is the same for all.
    for (const file of spec.files) outcome.failed.push({ view: file.view, reason: describe(error) })
    return outcome
  }
  const deadline = Date.now() + TOTAL_BUDGET_MS
  const queue = [...spec.files]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const file = queue.shift()
      if (!file) return
      if (Date.now() >= deadline) {
        outcome.failed.push({ view: file.view, reason: 'reference download budget exhausted' })
        continue
      }
      const failure = await downloadOne(dir, spec, file, options)
      if (failure) outcome.failed.push({ view: file.view, reason: failure })
      else outcome.written.push({ fileName: file.fileName, view: file.view })
    }
  })
  await Promise.all(workers)
  // Emitted in MANIFEST order rather than completion order, so the list the agent reads matches
  // the one the backend composed (its own gallery order) however the transfers interleaved.
  const rank = new Map(spec.files.map((file, index) => [file.view, index] as const))
  outcome.written.sort((a, b) => (rank.get(a.view) ?? 0) - (rank.get(b.view) ?? 0))
  outcome.failed.sort((a, b) => (rank.get(a.view) ?? 0) - (rank.get(b.view) ?? 0))
  // Even a partial set must not reach the agent's PR (same rule as every other context file).
  await excludeContextDir(cwd)
  return outcome
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
  if (outcome.failed.length) {
    options.log.warn('agent: some reference designs could not be downloaded', {
      written: outcome.written.length,
      failed: outcome.failed.length,
      reasons: outcome.failed.map((file) => file.reason).slice(0, 5),
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
    const bytes = new Uint8Array(await response.arrayBuffer())
    // A zero-length body is a miss, not a file: written out it would be an image the agent opens,
    // finds empty, and reads as a design with nothing on the screen.
    if (!bytes.byteLength) return 'empty response'
    if (bytes.byteLength > MAX_REFERENCE_BYTES) return 'reference exceeds size limit'
    await writeFile(join(dir, file.fileName), bytes)
    return undefined
  } catch (error) {
    return describe(error)
  }
}

/** A one-line cause for a failed transfer (never the token, which only rides a header). */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The prompt block naming what the agent was handed, or '' when the pass produced nothing at all.
 *
 * States the FAILURES beside the files, because the whole point of writing this directory is that
 * the tester captures the same views the gate will pair against: a reference that did not arrive
 * is a view the agent should still capture (under that name) rather than one that does not exist.
 */
export function referenceScreenshotGuidance(outcome: ReferenceScreenshotOutcome): string {
  if (!outcome.written.length && !outcome.failed.length) return ''
  const lines = outcome.written.map((file) => `- \`${outcome.dir}/${file.fileName}\`: ${file.view}`)
  const missing = outcome.failed.map((file) => `- ${file.view}: NOT on disk (${file.reason})`)
  return `

## Reference designs (capture these views)
The reference designs for this task are on disk in \`${outcome.dir}/\`. Capture the matching views
and name each screenshot's \`view\` EXACTLY as named below, so the platform can pair your capture
with its reference. Capture any other view the task needs under a name of your own.
${lines.join('\n')}${
    missing.length
      ? `\n\nThese references exist but could NOT be delivered to this container. Capture the views
anyway, under exactly these names. There is simply no image here to compare against:\n${missing.join('\n')}`
      : ''
  }`
}
