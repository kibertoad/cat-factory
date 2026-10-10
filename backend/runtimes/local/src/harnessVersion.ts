import { fetchHarnessVersion, type HarnessEndpoint } from './harnessHttp.js'
import { RECOMMENDED_HARNESS_IMAGE } from './harnessImage.js'

// The executor-harness version handshake: a safety net that fails a local dispatch LOUDLY
// and EARLY when the running harness does not match the version this backend build is
// released against — rather than letting a stale/mismatched executor surface as a cryptic
// downstream error (the class of bug where a since-removed git flag reappears in an old
// image and breaks every authenticated clone/push). The harness self-reports its version on
// `/health` (see the harness `version.ts`); this compares that to the matched version and
// decides whether to proceed, warn, or refuse.

/** What was actually launched, for an actionable remediation message. */
export interface HarnessVersionSource {
  /** The image ref (container transport) or harness entry path (native transport). */
  ref: string
  kind: 'image' | 'native'
}

export type HarnessVersionDecision =
  | { level: 'ok' }
  /** No matched version to check against — nothing to enforce. */
  | { level: 'skip'; message: string }
  /** Mismatch, but the operator opted into a custom harness, so advise rather than block. */
  | { level: 'warn'; message: string }
  /** Mismatch on a stock (matched) deployment — refuse to dispatch. */
  | { level: 'fail'; message: string }

/**
 * The version string embedded in an image ref's tag, or undefined when there is no concrete
 * version tag to compare (a digest pin, a mutable `:latest`/`:main`/`:edge`, or a bare local
 * build). Only a tag STARTING WITH A DIGIT is treated as a version — a named tag is not one.
 */
export function parseImageVersion(ref: string): string | undefined {
  const noDigest = ref.split('@')[0] ?? ref
  const lastColon = noDigest.lastIndexOf(':')
  const lastSlash = noDigest.lastIndexOf('/')
  if (lastColon <= lastSlash) return undefined // no tag segment
  const tag = noDigest.slice(lastColon + 1)
  return /^\d[\w.\-+]*$/.test(tag) ? tag : undefined
}

/** The harness version this backend build is matched to (from {@link RECOMMENDED_HARNESS_IMAGE}). */
export function recommendedHarnessVersion(): string | undefined {
  return parseImageVersion(RECOMMENDED_HARNESS_IMAGE)
}

/**
 * Decide whether a running harness's reported version is acceptable. Pure, so the policy is
 * unit-tested without any HTTP. A custom override downgrades a mismatch to a warning (the
 * operator deliberately pinned a different harness); a stock deployment hard-fails so the
 * skew can't silently corrupt runs. A missing reported version is itself a mismatch — an old
 * harness predating the handshake — treated the same as a wrong one.
 */
export function decideHarnessVersion(opts: {
  reported: string | undefined
  expected: string | undefined
  custom: boolean
  source: HarnessVersionSource
}): HarnessVersionDecision {
  const { reported, expected, custom, source } = opts
  if (!expected) {
    return { level: 'skip', message: 'no matched harness version to check against' }
  }
  if (reported && reported === expected) return { level: 'ok' }

  const running = reported
    ? `reports version ${reported}`
    : 'did not report a version (it predates the version handshake and is almost certainly stale)'
  const remediation =
    source.kind === 'image'
      ? `Re-pull it (e.g. \`docker pull ${source.ref}\`), or unset/point LOCAL_HARNESS_IMAGE at the matching version, then restart.`
      : `Update @cat-factory/executor-harness (or rebuild the dist that LOCAL_HARNESS_ENTRY points at: ${source.ref}), then restart.`
  const message =
    `Executor harness version mismatch: this backend is matched to harness ${expected}, but the ` +
    `running executor (${source.ref}) ${running}. ${remediation}`

  if (custom) {
    return {
      level: 'warn',
      message: `${message} A custom harness override is set, so this is a warning, not a hard stop — ensure it is compatible.`,
    }
  }
  return { level: 'fail', message }
}

/**
 * Verify the running harness at `endpoint` matches the expected version, throwing (a loud,
 * actionable Error) on a hard mismatch and calling `onWarn` on a soft (custom-override) one.
 * A no-op when there is no expected version to check against. Called by both local transports
 * once a freshly-started harness becomes healthy, so a skew fails the FIRST dispatch with a
 * clear message rather than deep inside a git operation.
 */
export async function verifyHarnessVersion(opts: {
  fetchImpl: typeof fetch
  endpoint: HarnessEndpoint
  secret: string
  requestTimeoutMs: number
  expected: string | undefined
  custom: boolean
  source: HarnessVersionSource
  onWarn?: (message: string) => void
}): Promise<void> {
  if (!opts.expected) return
  const reported = await fetchHarnessVersion(
    opts.fetchImpl,
    opts.endpoint,
    opts.secret,
    opts.requestTimeoutMs,
  )
  const decision = decideHarnessVersion({
    reported,
    expected: opts.expected,
    custom: opts.custom,
    source: opts.source,
  })
  if (decision.level === 'fail') throw new Error(decision.message)
  if (decision.level === 'warn') opts.onWarn?.(decision.message)
}
