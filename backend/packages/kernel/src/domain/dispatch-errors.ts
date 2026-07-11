// ---------------------------------------------------------------------------
// Structured identity + human remedy for container/runner DISPATCH failures.
//
// Every `RunnerTransport.dispatch()` used to throw a bare
//   `<label> dispatch failed (HTTP <status>): <body>`
// which named the symptom (an HTTP status) but not the cause or the fix — and, worse, a
// 404 (the deployed executor-harness image predates the `/jobs` route: a stale image whose
// tag was never bumped, so new containers run stale code) read identically to a transient
// 5xx capacity blip. Downstream, `BootstrapService` / `EnvConfigRepairService` then decided
// "was this a dispatch failure?" by regex-matching `/dispatch failed/i` on the message — so
// error IDENTITY rode a string, and a self-hosted-pool fault (`Runner pool … → <status>`,
// a different wording) fell through and was mislabelled a `preflight` error.
//
// This module is the single place that turns a dispatch rejection into an actionable error:
//   - `DispatchError` carries the HTTP `status` as a STRUCTURED field, so consumers branch on
//     `instanceof DispatchError` / `dispatchStatusOf(error)` instead of the message shape.
//   - `harnessDispatchFailureMessage` PRESERVES the raw `<label> dispatch failed (HTTP n): body`
//     first line (callers surface it as detail, it stays greppable, and the legacy regex still
//     matches it) and, on a 404, APPENDS the stale-image cause + republish remedy.
//
// Mirrors the `describeVcsApiError` / `GitHubApiError.status` shape: elaborating the human
// message never changes classification, because identity rides the field. Kernel sits BELOW
// the server layer, so it cannot import `@cat-factory/server`'s `config/docs.ts`; per the
// doc-URL convention a package outside the server layer keeps its own doc-URL constant — this
// is that equivalent (see `VCS_DOC_URLS` for the sibling case).
// ---------------------------------------------------------------------------

const REPO_DOC_BLOB_BASE = 'https://github.com/kibertoad/cat-factory/blob/main'

/** In-repo docs the dispatch remedies deep-link to. */
export const DISPATCH_DOC_URLS = {
  /** How to republish + roll out the runner image under a fresh tag (the 404 remedy). */
  runnerImage: `${REPO_DOC_BLOB_BASE}/CONTRIBUTING.md#publishing-the-runner-image-to-cloudflare-maintainer-only`,
} as const

/**
 * A transport `dispatch()` rejection: the container/runner never accepted the job. Carries the
 * HTTP `status` so consumers classify the failure by field (`instanceof` / {@link dispatchStatusOf})
 * rather than regex-matching the message. `status` is `0` when there was no HTTP response (a
 * pre-request or network fault). The `message` is already elaborated by the producer (raw first
 * line + any cause/remedy), so it is safe to surface verbatim.
 */
export class DispatchError extends Error {
  constructor(
    message: string,
    /** The HTTP status the runner returned rejecting the dispatch; `0` = no HTTP response. */
    readonly status: number,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * Build the message for a rejected harness `/jobs` dispatch: the raw
 * `<label> dispatch failed (HTTP <status>): <body>` line (unchanged, so downstream detail +
 * greps + the legacy `/dispatch failed/i` fallback still work) followed, on a 404, by the
 * stale-image cause + republish remedy. A 404 from the harness `/jobs` POST means the deployed
 * executor-harness image is too old to know this route — the classic "tag wasn't bumped, so new
 * containers run stale code" footgun.
 */
export function harnessDispatchFailureMessage(opts: {
  label: string
  status: number
  body: string
}): string {
  const raw = `${opts.label} dispatch failed (HTTP ${opts.status}): ${opts.body}`
  if (opts.status !== 404) return raw
  return (
    `${raw}\n` +
    'Cause: the runner returned 404 Not Found for the harness /jobs route — the deployed ' +
    'executor-harness image predates this dispatch route (its tag was never bumped, so new ' +
    'containers run stale code). Fix: republish the executor-harness image under a fresh, ' +
    `immutable tag and roll it out, then retry. See ${DISPATCH_DOC_URLS.runnerImage}.`
  )
}

/**
 * A {@link DispatchError} for a rejected harness `/jobs` dispatch, with the message elaborated by
 * {@link harnessDispatchFailureMessage}. The single throw helper the container/pod/local harness
 * transports use so the wording + the 404 remedy live in ONE place.
 */
export function harnessDispatchError(opts: {
  label: string
  status: number
  body: string
}): DispatchError {
  return new DispatchError(harnessDispatchFailureMessage(opts), opts.status)
}

/**
 * Whether a throw is a transport DISPATCH rejection (the container/runner never accepted the
 * job). Prefers the structured {@link DispatchError}, falling back to the legacy
 * `<label> dispatch failed (HTTP n)` message shape so any producer that still throws a plain
 * `Error` is classified the same — the "add the field, demote the regex to fallback" pattern.
 */
export function isDispatchFailure(error: unknown): boolean {
  if (error instanceof DispatchError) return true
  return error instanceof Error && /dispatch failed/i.test(error.message)
}
