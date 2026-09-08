#!/usr/bin/env node
// Checks the OpenRouter model slugs PINNED in the spend price table against the gateway's live
// catalogue.
//
// Why it exists: `backend/packages/spend/src/pricing.ts` names ~20 `openrouter:<vendor>/<model>`
// rows with hand-read prices. Those are pins, and a pin has a silent failure mode. OpenRouter does
// not renumber a model it still serves, so a pin stays correct until the model is WITHDRAWN, and
// when it is, nothing here fails. The route simply stops resolving, the spend gate falls back to
// the bare-`openrouter` per-provider rate, and a budget quietly starts metering against a number
// nobody chose. A withdrawn pin is also wrong in every deployment at once, which is exactly the
// class of mistake that should not be discovered in somebody's own installation.
//
// It also reports PRICE DRIFT, because the pinned numbers are a second thing that rots: OpenRouter
// passes the upstream vendor's rates through, and a vendor repricing a model leaves our table
// stating the old one. Drift is advisory (see the exit code below): the table is deliberately
// conservative (a fixed 0.92 EUR/USD margin), so being ABOVE the live rate is the intended state
// and only a pin that now UNDERSTATES the live price is worth acting on. Enabling a model in the
// per-workspace OpenRouter catalog overrides the table entirely (`withDynamicPrices`), so drift is
// a default-quality problem, not a correctness one.
//
// What is compared is the EFFECTIVE rate for each of four classes, not only the numbers a row
// spells out. A row NAMES a cache rate only where the vendor departs from the `CACHE_*_MULTIPLIER`
// floor, and this check used to skip the rest on the grounds that a derived class has no pinned
// number to have drifted. That is the reasoning, and it is wrong in the one direction that costs
// money: the derived figure is still what the budget meters with, and it follows OUR input rate
// rather than the vendor's cache rate, so a vendor lifting a cache read above the floor leaves the
// gate under-charging with nothing pinned to look stale. `openrouter:z-ai/glm-5.3` sat at 54% of
// its live cache read for exactly that reason while this report said "nothing to do".
//
// A derived cache class is compared only where a hit can actually LAND on the route: the gateway
// prefix must cache on a request this platform builds, which is read out of the contracts policy
// map rather than restated (see `readGatewayCachingPrefixes`). Several vendors publish a cache rate
// while OpenRouter's route needs `cache_control` breakpoints nothing here emits, and reporting an
// unreachable class is the noise that trains a reader to skim past the reachable one.
//
// The live side is the DEAREST band the route publishes rather than its base rate, because a model
// that reprices a whole request past a prompt threshold has two prices and this table has one slot
// (see `dearestBandRate`). That read alone turned six rows from clean to understated.
//
// NOT a per-PR guard: it makes a network call, so it belongs on the same weekly cadence as the
// external-API sweep. Run it by hand any time.
//
// Usage:
//   node scripts/check-openrouter-pins.mjs                       # text report
//   node scripts/check-openrouter-pins.mjs --json                # machine-readable
//   node scripts/check-openrouter-pins.mjs --base-url <url>      # a mirror or a stub
//   node scripts/check-openrouter-pins.mjs --timeout 60000
//
// Exit code is 1 when a pin names a slug the gateway no longer serves, so CI can hold the line
// unattended; price drift alone exits 0 and reports.

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRICING_FILE = 'backend/packages/spend/src/pricing.ts'
const CACHE_POLICY_FILE = 'backend/packages/contracts/src/cache-policy.ts'
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * The USD→EUR factor the price table bakes in, restated here rather than imported.
 *
 * `pricing.ts` is TypeScript this plain-Node script cannot load without a build step, and the
 * factor is a documented constant of that table rather than something derived. Kept beside a
 * check that FAILS when it drifts (see `assertRateMatchesTable`), so the copy cannot rot quietly.
 */
const USD_TO_EUR = 0.92

/**
 * The rate fields, mapped to the `/models` pricing key each is read against and to the
 * `CACHE_*_MULTIPLIER` the table falls back to when a row leaves the field out.
 *
 * `multiplier` is what makes the two cache classes comparable at all: a row names one only where
 * the vendor departs from the floor, so most rows have no cache number of their own and the
 * budget meters them at `inputPerMillion` times this factor. Comparing the named value alone
 * checks the minority of rows and calls the majority clean.
 *
 * Both cache classes are here even though today only the read is ever the finding. A gateway
 * route that bills a cache WRITE publishes `input_cache_write` (OpenAI's and Google's do), so the
 * class is live on routes this table pins; leaving it out would make the next vendor to lift it
 * above the 1.25x floor a silent under-charge of exactly the kind the read class just was.
 */
const RATE_FIELDS = [
  { field: 'inputPerMillion', priceKey: 'prompt' },
  { field: 'outputPerMillion', priceKey: 'completion' },
  {
    field: 'cacheReadPerMillion',
    priceKey: 'input_cache_read',
    multiplier: 'CACHE_READ_MULTIPLIER',
  },
  {
    field: 'cacheWritePerMillion',
    priceKey: 'input_cache_write',
    multiplier: 'CACHE_WRITE_MULTIPLIER',
  },
]

/** Pull the pinned `openrouter:<slug>` rows and their per-million rates out of the price table. */
export function readPinnedSlugs(source) {
  const pins = []
  // The rows are object literals keyed by a quoted ref. A row's numbers may sit on the same line
  // or be spread across several, so the value block is matched up to its closing brace rather
  // than to the end of the line.
  const rowRe = /'openrouter:([^']+)'\s*:\s*\{([^}]*)\}/g
  let match
  while ((match = rowRe.exec(source)) !== null) {
    const [, slug, body] = match
    const pin = { slug }
    for (const { field } of RATE_FIELDS) pin[field] = readNumber(body, field)
    pins.push(pin)
  }
  return pins
}

function readNumber(body, key) {
  const found = new RegExp(`${key}\\s*:\\s*([0-9]*\\.?[0-9]+)`).exec(body)
  return found ? Number(found[1]) : undefined
}

/**
 * The `CACHE_*_MULTIPLIER` factors, READ OUT of the price table rather than restated here.
 *
 * The USD→EUR factor above is a copy guarded by a prose check, and that shape is only defensible
 * because it is one number the table documents in words. These two are exported constants with a
 * literal value on the line, so they can be read, and a read cannot rot: a copy that drifted would
 * compute a floor the budget never uses and report drift against a number nobody meters with.
 *
 * Throws when either is missing. A default here would be the same silent pass this whole check
 * exists to rule out, one level down.
 */
export function readCacheMultipliers(source) {
  const multipliers = {}
  for (const { multiplier } of RATE_FIELDS) {
    if (!multiplier) continue
    const found = new RegExp(`${multiplier}\\s*=\\s*([0-9]*\\.?[0-9]+)`).exec(source)
    if (!found) {
      throw new Error(
        `${PRICING_FILE} no longer exports ${multiplier} with a literal value. The derived cache ` +
          'rates cannot be checked against the live catalogue until this script reads the new shape.',
      )
    }
    multipliers[multiplier] = Number(found[1])
  }
  return multipliers
}

/**
 * The gateway vendor prefixes a prompt-cache hit can actually land on, read out of the contracts
 * policy map (`GATEWAY_PREFIX_POLICY`) that every runtime reader already agrees about.
 *
 * Only `auto-prefix` counts. `explicit-anthropic` means the route caches on `cache_control`
 * breakpoints, `providerCachePolicy` downgrades it to `none` for a gateway because nothing on this
 * path emits them, and a rate on a cache nobody enters is not a rate this platform meters. A
 * prefix absent from the map answers `none` there and is skipped here for the same reason.
 *
 * DERIVED rather than copied, and it has to be: the map is the thing most likely to gain a member,
 * and a stale copy would either invent exposure on a route that caches nothing or, worse, keep
 * quiet about a route that started to.
 */
export function readGatewayCachingPrefixes(source) {
  const block = /GATEWAY_PREFIX_POLICY[^=]*=\s*\{([^}]*)\}/.exec(source)
  if (!block) {
    throw new Error(
      `${CACHE_POLICY_FILE} no longer declares a GATEWAY_PREFIX_POLICY object literal. The ` +
        'derived cache rates cannot be checked until this script reads the new shape.',
    )
  }
  const prefixes = new Set()
  const entryRe = /'?([a-zA-Z0-9_-]+)'?\s*:\s*'([a-z-]+)'/g
  let entry
  while ((entry = entryRe.exec(block[1])) !== null) {
    if (entry[2] === 'auto-prefix') prefixes.add(entry[1].toLowerCase())
  }
  if (prefixes.size === 0) {
    throw new Error(
      `${CACHE_POLICY_FILE} declares no 'auto-prefix' gateway vendor. That would silence every ` +
        'derived cache-rate comparison, so it is treated as a parse failure rather than a result.',
    )
  }
  return prefixes
}

/** The vendor half of a gateway slug, the half {@link readGatewayCachingPrefixes} keys on. */
function vendorPrefix(slug) {
  const slash = slug.indexOf('/')
  return slash <= 0 ? '' : slug.slice(0, slash).toLowerCase()
}

/** USD per token (OpenRouter's string form) → EUR per million, the unit the table states. */
export function eurPerMillion(usdPerToken) {
  if (usdPerToken === undefined || usdPerToken === null || usdPerToken === '') return undefined
  const n = Number(usdPerToken)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 1_000_000 * USD_TO_EUR * 10_000) / 10_000
}

/**
 * The DEAREST rate a route can bill this class at: the base rate, or a long-context band if the
 * gateway publishes one.
 *
 * Several models bill in two bands, where a prompt past a threshold reprices the WHOLE request:
 * OpenAI at 272K input tokens, Gemini 3.1 Pro and Grok 4.6 at 200K. OpenRouter states each as an
 * `overrides: [{ min_prompt_tokens, … }]` entry beside the base pricing. The price table has ONE
 * slot per model and no way to express a threshold that depends on the prompt actually sent, so it
 * prices the long band by convention: the budget gate may over-meter a short prompt and may never
 * under-meter a long one.
 *
 * Comparing against the base rate alone is therefore checking the wrong number, and it read as a
 * pass on five OpenAI rows and one Gemini row sitting at half their long-band input.
 *
 * The same fold, for the same stated reason, is what the DYNAMIC per-workspace overlay already
 * does (`dearestRate` in `openRouterModels.ts`). The static table and this check were the two
 * places the rule had not reached, which is how they came to contradict the path they sit behind.
 */
export function dearestBandRate(pricing, priceKey) {
  const bands = [pricing?.[priceKey], ...(pricing?.overrides ?? []).map((b) => b?.[priceKey])]
  const rates = bands.map(eurPerMillion).filter((r) => r !== undefined)
  return rates.length === 0 ? undefined : Math.max(...rates)
}

/**
 * How far BELOW the live rate a pin may sit before it is worth reporting.
 *
 * Not a softening of the rule, a noise floor. The pinned numbers are the live USD rate times a
 * fixed 0.92 and then hand-rounded to 2-3 decimals, so a pin written from the correct rate still
 * lands a fraction under it: four of the five findings on the first live run were exactly that,
 * the largest being 0.18 against 0.184. Reporting those trains a reader to skim past the one that
 * matters (a pin sitting at a THIRD of the live rate). One percent is comfortably above the
 * rounding step and far below the table's own ~7% conservative margin.
 */
const UNDERSTATEMENT_TOLERANCE = 0.01

/** Whether `pinned` sits materially below `live`; see {@link UNDERSTATEMENT_TOLERANCE}. */
function understates(pinned, live) {
  if (live === undefined || pinned === undefined || live <= 0) return false
  return pinned < live * (1 - UNDERSTATEMENT_TOLERANCE)
}

/**
 * The rate a budget would actually meter this class at: the number the row names, else the one
 * the table derives from its input rate.
 *
 * Returns `undefined` where there is nothing to compare, and the two reasons for that are
 * different facts kept apart on purpose. A class with no multiplier (input, output) simply has no
 * derived form, so an absent pin is an absent row. A CACHE class on a route that does not cache on
 * a request this platform builds has a derived number, and it is unreachable: no hit lands, so the
 * figure is never metered and reporting it against a published rate would be a finding about
 * arithmetic rather than about money.
 */
export function effectiveRate(pin, field, cacheMultipliers, cachingPrefixes) {
  const named = pin[field]
  if (named !== undefined) return { rate: named, derived: false }
  const spec = RATE_FIELDS.find((f) => f.field === field)
  if (!spec?.multiplier || pin.inputPerMillion === undefined) return undefined
  if (!cachingPrefixes.has(vendorPrefix(pin.slug))) return undefined
  return { rate: pin.inputPerMillion * cacheMultipliers[spec.multiplier], derived: true }
}

/**
 * Compare each pin against the live catalogue.
 *
 * `served` / `withdrawn` answer "is this route still there"; `understated` answers "would this row
 * UNDER-charge a budget". Only the first can fail the run, for the reason in the header: the table
 * is meant to sit above the live rate, so overstating is the design and understating is the bug.
 *
 * `cacheMultipliers` and `cachingPrefixes` come from the two source reads rather than from
 * defaults, so a caller that skipped them would silently check less than it appears to.
 */
export function comparePins(pins, catalogue, { cacheMultipliers, cachingPrefixes }) {
  const served = []
  const withdrawn = []
  const understated = []
  for (const pin of pins) {
    const model = catalogue.get(pin.slug)
    if (!model) {
      withdrawn.push({ ...pin, nearMatches: nearMatches(pin.slug, catalogue) })
      continue
    }
    served.push(pin.slug)
    // Only a rate materially BELOW the live one is reported: a budget metering less than the call
    // costs. Above it is the table's intended margin and says nothing.
    const under = []
    for (const { field, priceKey } of RATE_FIELDS) {
      const effective = effectiveRate(pin, field, cacheMultipliers, cachingPrefixes)
      const live = dearestBandRate(model.pricing, priceKey)
      if (effective && understates(effective.rate, live)) {
        under.push({ field, pinned: effective.rate, live, derived: effective.derived })
      }
    }
    if (under.length > 0) understated.push({ slug: pin.slug, fields: under })
  }
  return { served, withdrawn, understated }
}

/**
 * Slugs that look like the withdrawn one: a LEAD for a human, never an instruction.
 *
 * A revision suffix is part of a model's identity (`claude-opus-4.8` is not a drop-in for a row
 * pinned to `claude-opus-5`), so this only groups by the vendor half and by a shared leading token
 * of the model half. Picking a "closest" match automatically is how a repin lands on a model with
 * different prices and a different context window.
 */
function nearMatches(slug, catalogue) {
  const [vendor, model = ''] = slug.split('/')
  const stem = model.split('-')[0]?.toLowerCase() ?? ''
  return [...catalogue.keys()]
    .filter((candidate) => {
      const [otherVendor, otherModel = ''] = candidate.split('/')
      return otherVendor === vendor && stem.length > 0 && otherModel.toLowerCase().startsWith(stem)
    })
    .sort()
    .slice(0, 5)
}

/** Fetch the live catalogue as a slug→model map. No API key: `/models` answers unauthenticated. */
async function loadCatalogue(baseUrl, timeoutMs) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`OpenRouter answered HTTP ${res.status} at ${url}`)
  const body = await res.json()
  const models = new Map()
  for (const model of body?.data ?? []) {
    if (typeof model?.id === 'string' && model.id.length > 0) models.set(model.id, model)
  }
  if (models.size === 0) throw new Error(`OpenRouter returned no models at ${url}`)
  return models
}

/**
 * Fail if the table's stated conversion factor is no longer the one this script assumes.
 *
 * The copy above is the price of not being able to import TypeScript here. This is what keeps it
 * honest: the table documents the factor in prose beside the constant, so the check reads it back
 * out and refuses to report drift computed against a number the table no longer uses.
 */
function assertRateMatchesTable(source) {
  if (!/0\.92 EUR\/USD/.test(source)) {
    throw new Error(
      `${PRICING_FILE} no longer documents a 0.92 EUR/USD factor. Update USD_TO_EUR in ` +
        'scripts/check-openrouter-pins.mjs to match before trusting its drift report.',
    )
  }
}

function parseArgs(argv) {
  const args = { json: false, baseUrl: DEFAULT_BASE_URL, timeoutMs: DEFAULT_TIMEOUT_MS }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true
    else if (argv[i] === '--base-url') args.baseUrl = argv[++i] ?? args.baseUrl
    else if (argv[i] === '--timeout') args.timeoutMs = Number(argv[++i]) || args.timeoutMs
  }
  return args
}

function report(result, pinCount) {
  const lines = [`Checked ${pinCount} pinned OpenRouter slugs in ${PRICING_FILE}.`, '']
  lines.push(`Served (${result.served.length}): nothing to do`)
  if (result.withdrawn.length > 0) {
    lines.push('', `Withdrawn (${result.withdrawn.length}): the gateway no longer serves these:`)
    for (const pin of result.withdrawn) {
      const leads = pin.nearMatches.length > 0 ? `  near: ${pin.nearMatches.join(', ')}` : ''
      lines.push(`  ${pin.slug}${leads}`)
    }
    lines.push(
      '',
      'A near match is a LEAD, not a repin: a revision suffix is part of a model’s identity,',
      'and prices and context windows move with it. Re-read the replacement before pinning it.',
    )
  }
  if (result.understated.length > 0) {
    lines.push(
      '',
      `Understated (${result.understated.length}): the row meters BELOW the live rate:`,
    )
    for (const { slug, fields } of result.understated) {
      for (const f of fields) {
        // A derived rate is labelled, because the fix differs: a named number is re-read off the
        // vendor, while a derived one has to be NAMED before it can be corrected at all.
        const how = f.derived ? ' [derived from inputPerMillion]' : ''
        lines.push(`  ${slug} ${f.field}: ${f.pinned}, live ${f.live} (EUR/1M)${how}`)
      }
    }
    lines.push(
      '',
      'Advisory. The table is deliberately conservative, so sitting ABOVE the live rate is the',
      'design; only these UNDER-charge a budget. Enabling the model in a workspace’s OpenRouter',
      'catalog overrides the table entirely. A [derived] finding is fixed by NAMING the class on',
      'that row, not by moving its input rate, which every other class follows.',
    )
  }
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const source = readFileSync(join(repoRoot, PRICING_FILE), 'utf8')
  assertRateMatchesTable(source)
  const pins = readPinnedSlugs(source)
  if (pins.length === 0) {
    console.error(`No 'openrouter:<slug>' rows found in ${PRICING_FILE}. Has the table moved?`)
    process.exit(1)
  }
  const cacheMultipliers = readCacheMultipliers(source)
  const cachingPrefixes = readGatewayCachingPrefixes(
    readFileSync(join(repoRoot, CACHE_POLICY_FILE), 'utf8'),
  )
  const catalogue = await loadCatalogue(args.baseUrl, args.timeoutMs)
  const result = comparePins(pins, catalogue, { cacheMultipliers, cachingPrefixes })
  console.log(
    args.json
      ? JSON.stringify({ pins: pins.length, ...result }, null, 2)
      : report(result, pins.length),
  )
  if (result.withdrawn.length > 0) process.exit(1)
}

// Importable for its own fixtures (`scripts/openrouter-pins.test.mjs`) without making the network
// call: only a direct run reaches the gateway. `pathToFileURL` rather than a hand-built
// `file://` + path. On Windows the two differ by a slash (`file:///C:/...` against `file://C:/...`),
// so the hand-built form never matches and a direct run silently does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`OpenRouter pin check failed: ${error.message}`)
    process.exit(1)
  })
}
