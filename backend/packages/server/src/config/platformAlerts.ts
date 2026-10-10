import type { PlatformAlertWindow, PlatformFailureKindRule } from '@cat-factory/contracts'
import {
  isAgentFailureKind,
  MAX_FAILURE_KIND_LENGTH,
  MAX_FAILURE_KIND_RULES,
} from '@cat-factory/contracts'
import { DEFAULT_PLATFORM_ALERT_THRESHOLDS } from '@cat-factory/orchestration'
import type { PlatformAlertConfig } from './types.js'
import { parseNumericEnv } from './numeric.js'
import { DOCS } from './docs.js'
import { configWarnings } from './warnOnce.js'

// Shared, runtime-neutral parser for the platform-health alerting env, so the Worker's
// `loadConfig` and the Node/local `loadNodeConfig` derive an IDENTICAL `PlatformAlertConfig`
// from the same vars + defaults + clamps ("keep the runtimes symmetric"). Each facade reads
// its own env source (Cloudflare `Env` vs `process.env`) into the raw-string bag below and
// calls this — the parsing/clamping lives in exactly one place.

/** How often the Node sweep runs when `PLATFORM_ALERTS_INTERVAL_MS` is unset (5 minutes). */
const DEFAULT_PLATFORM_ALERT_INTERVAL_MS = 5 * 60_000
/** Floor the interval so a `0`/tiny override can't turn the sweep into a busy-loop. */
const MIN_PLATFORM_ALERT_INTERVAL_MS = 10_000

/**
 * Parse the `1h`/`24h`/`7d` alert window, defaulting to the most operationally useful `1h`.
 * The dashboard's rollup-backed `30d`/`90d` windows are deliberately not accepted here (see
 * `platformAlertWindowSchema`), so naming one falls back to `1h` rather than quietly
 * evaluating an alert against a table materialised at best hourly.
 */
export function parsePlatformObservabilityWindow(raw: string | undefined): PlatformAlertWindow {
  const v = raw?.trim()
  return v === '24h' || v === '7d' ? v : '1h'
}

/** The raw env strings each facade feeds the parser (already extracted from its env source). */
export interface PlatformAlertEnvInput {
  /** Whether `PLATFORM_ALERTS` opted the sweep in. */
  enabled: boolean
  window?: string
  intervalMs?: string
  minRuns?: string
  maxFailureRate?: string
  maxP99Minutes?: string
  maxBacklog?: string
  stalledBuckets?: string
  minStalledPriorRuns?: string
  maxFailureKindShare?: string
  maxSweepFailures?: string
  /** `PLATFORM_ALERTS_FAILURE_KIND_RATES`, e.g. `evicted=0.05:3,timeout=0.2`. */
  failureKindRates?: string
}

/** The env var the per-kind rules come from, named once so the warnings below agree. */
const FAILURE_KIND_RATES_VAR = 'PLATFORM_ALERTS_FAILURE_KIND_RATES'

/**
 * Parse the per-kind alert rules from one env string: a comma-separated list of
 * `kind=share[:minCount]` entries, e.g. `evicted=0.05:3,timeout=0.2`.
 *
 * Every rejection is REPORTED and only the offending entry is dropped, rather than the value
 * being taken as a whole or discarded as a whole. Both alternatives are worse in the same
 * direction: an operator who typed one rule wrongly is told which, and keeps the rules they
 * typed correctly, instead of finding out on the night the alert did not page. A rule that
 * cannot be read is not a rule, so it is never guessed at (a `share` outside (0, 1] is not
 * clamped into range here, unlike a scalar ceiling: clamping `evicted=50` to 1.0 would invent
 * "when EVERY failure is an eviction" out of somebody meaning 50%).
 *
 * An UNRECOGNISED kind is the one problem reported without dropping the rule, because dropping
 * it and keeping it silently are both wrong for different halves of the same case. A kind this
 * build does not produce is either a typo or a kind a later release retired, and nothing here
 * can tell those apart — so the rule is kept (a retired kind is data an operator should get to
 * decide about, exactly as in the settings editor) and the fact that it can never fire is
 * STATED. Left silent it is the worst outcome the whole var has: a pager somebody deliberately
 * armed, indistinguishable from a kind that simply never occurred, discovered on the night it
 * did not go off.
 */
export function parseFailureKindRules(raw: string | undefined): PlatformFailureKindRule[] {
  if (raw === undefined || raw.trim() === '') return []
  const rules: PlatformFailureKindRule[] = []
  const seen = new Set<string>()
  const warn = (entry: string, what: string) => {
    configWarnings.warnOnce(
      `${FAILURE_KIND_RATES_VAR} entry "${entry}" ${what} ` +
        `Expected \`kind=share[:minCount]\` with share in (0, 1], e.g. \`evicted=0.05:3\`. ` +
        `See ${DOCS.envVars()}.`,
      { var: FAILURE_KIND_RATES_VAR, entry, docsUrl: DOCS.envVars() },
    )
  }
  const reject = (entry: string, why: string) => warn(entry, `${why}, so this rule is ignored.`)
  for (const entry of raw.split(',')) {
    const text = entry.trim()
    if (text === '') continue
    const eq = text.indexOf('=')
    if (eq <= 0) {
      reject(text, 'is not `kind=share`')
      continue
    }
    const kind = text.slice(0, eq).trim()
    const [shareText, countText, ...extra] = text
      .slice(eq + 1)
      .split(':')
      .map((part) => part.trim())
    if (kind === '' || extra.length > 0) {
      reject(text, 'is not `kind=share[:minCount]`')
      continue
    }
    // Held to the SAME bound as a settings-authored rule (`platformFailureKindRuleSchema`),
    // though an env-derived rule never passes through that schema: one of the two paths quietly
    // accepting what the other refuses is how the deployment default and the account override
    // stop meaning the same thing.
    if (kind.length > MAX_FAILURE_KIND_LENGTH) {
      reject(text, `names a kind longer than ${MAX_FAILURE_KIND_LENGTH} characters`)
      continue
    }
    const share = Number(shareText)
    if (!Number.isFinite(share) || share <= 0 || share > 1) {
      reject(text, 'does not name a share greater than 0 and at most 1')
      continue
    }
    // Absent means the schema default (1), and is left ABSENT rather than written as 1: the rule
    // is stored and rendered alongside settings-authored ones, where an unset minimum reads as
    // inherited. `0` is refused rather than treated as unset, since a rule that fires on zero
    // occurrences of its kind is not something an operator can have meant.
    let minCount: number | undefined
    if (countText !== undefined && countText !== '') {
      const parsed = Number(countText)
      if (!Number.isInteger(parsed) || parsed < 1) {
        reject(text, 'does not name a whole minimum count of 1 or more')
        continue
      }
      minCount = parsed
    }
    if (seen.has(kind)) {
      reject(text, `repeats the kind "${kind}", which an earlier entry already covers`)
      continue
    }
    if (rules.length >= MAX_FAILURE_KIND_RULES) {
      reject(text, `is past the limit of ${MAX_FAILURE_KIND_RULES} per-kind rules`)
      continue
    }
    // Kept, not dropped: see the note above on why a kind this build does not produce is
    // reported rather than refused. The rule is inert until something produces that kind, and
    // saying so is the whole point — a rule that can never fire and a kind that never occurred
    // are otherwise the same silence.
    if (!isAgentFailureKind(kind)) {
      warn(
        text,
        `names "${kind}", which is not a failure kind this build produces, so the rule is kept ` +
          `but can never fire. Check the spelling, or drop the rule if the kind was retired.`,
      )
    }
    seen.add(kind)
    rules.push({ kind, maxShare: share, ...(minCount === undefined ? {} : { minCount }) })
  }
  return rules
}

/**
 * Resolve the platform-health alert config from raw env strings. Unset/blank/garbage values
 * fall back to {@link DEFAULT_PLATFORM_ALERT_THRESHOLDS} (a non-numeric value emits the shared
 * `parseNumericEnv` warning); negatives are treated as unset. The failure-rate ceiling is
 * clamped to 0..1, and the interval is floored so it can't busy-loop.
 */
export function resolvePlatformAlertConfig(env: PlatformAlertEnvInput): PlatformAlertConfig {
  const d = DEFAULT_PLATFORM_ALERT_THRESHOLDS
  const nonNeg = (name: string, raw: string | undefined, fallback: number): number => {
    const n = parseNumericEnv(name, raw)
    return n !== undefined && n >= 0 ? n : fallback
  }
  const maxP99Minutes = nonNeg(
    'PLATFORM_ALERTS_MAX_P99_MINUTES',
    env.maxP99Minutes,
    d.maxP99DurationMs / 60_000,
  )
  const failureRate = nonNeg(
    'PLATFORM_ALERTS_MAX_FAILURE_RATE',
    env.maxFailureRate,
    d.maxFailureRate,
  )
  return {
    enabled: env.enabled,
    window: parsePlatformObservabilityWindow(env.window),
    intervalMs: Math.max(
      MIN_PLATFORM_ALERT_INTERVAL_MS,
      nonNeg('PLATFORM_ALERTS_INTERVAL_MS', env.intervalMs, DEFAULT_PLATFORM_ALERT_INTERVAL_MS),
    ),
    thresholds: {
      minRuns: Math.max(1, nonNeg('PLATFORM_ALERTS_MIN_RUNS', env.minRuns, d.minRuns)),
      maxFailureRate: Math.min(1, failureRate),
      maxP99DurationMs: maxP99Minutes * 60_000,
      maxBacklog: Math.max(1, nonNeg('PLATFORM_ALERTS_MAX_BACKLOG', env.maxBacklog, d.maxBacklog)),
      // Floored at 1: a zero would make "the last zero buckets were empty" trivially true and
      // fire the stall alert on every healthy sweep.
      stalledBuckets: Math.max(
        1,
        nonNeg('PLATFORM_ALERTS_STALLED_BUCKETS', env.stalledBuckets, d.stalledBuckets),
      ),
      // NOT floored: 0 is a meaningful choice here — it says "alert on silence even if the
      // window was idle to begin with", which suits a deployment that should never be quiet.
      minStalledPriorRuns: nonNeg(
        'PLATFORM_ALERTS_MIN_STALLED_PRIOR_RUNS',
        env.minStalledPriorRuns,
        d.minStalledPriorRuns,
      ),
      // Clamped into (0, 1]. The upper clamp keeps "100% of failures" reachable; the lower one
      // matters for the same reason `stalledBuckets` is floored — a share of 0 is satisfied by
      // ANY failure distribution, so it would fire `failure_kind_dominant` on every window that
      // cleared `minRuns` and had a single failure, which is not a threshold anyone means to set.
      maxFailureKindShare: Math.min(
        1,
        Math.max(
          Number.EPSILON,
          nonNeg(
            'PLATFORM_ALERTS_MAX_FAILURE_KIND_SHARE',
            env.maxFailureKindShare,
            d.maxFailureKindShare,
          ),
        ),
      ),
      maxSweepFailures: Math.max(
        1,
        nonNeg('PLATFORM_ALERTS_MAX_SWEEP_FAILURES', env.maxSweepFailures, d.maxSweepFailures),
      ),
      // No fallback to the built-in default, unlike every scalar above, because there is nothing
      // to fall back to: the shipped default is an empty list, so an unset var and a var whose
      // every entry was rejected both resolve to "no per-kind rules" — and the rejected one has
      // already said so, once per entry, rather than resolving quietly.
      failureKindRules: parseFailureKindRules(env.failureKindRates),
    },
  }
}
