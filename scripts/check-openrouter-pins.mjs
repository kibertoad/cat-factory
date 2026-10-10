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
// Three properties of the comparison earn their complexity, and each is a class of understatement
// that a simpler read calls clean:
//
//  - The EFFECTIVE rate, not only the numbers a row spells out. A row NAMES a cache rate only
//    where the vendor departs from the `CACHE_*_MULTIPLIER` floor, and the derived figure is still
//    what the budget meters with. It follows OUR input rate rather than the vendor's cache rate,
//    so a vendor lifting a cache read above the floor leaves the gate under-charging with nothing
//    pinned to look stale (`openrouter:z-ai/glm-5.3` sat at 54% of its live cache read that way).
//  - BAND FOR BAND. Several models reprice a whole request past a prompt threshold, so a row can
//    carry two prices (`ModelPrice.longBand`) and each covers a different live band: the base
//    rates against the route's base band, the long band against the DEAREST band any override
//    publishes. A row carrying ONE price is compared against the dearest, because that is the rate
//    it has to cover on its own. The threshold is a pin too, so it is read against the lowest
//    `min_prompt_tokens` the route publishes.
//  - Only where a cache HIT can land, for the two cache classes. The gateway prefix must cache on
//    a request this platform builds, read out of the contracts policy map rather than restated
//    (see `readGatewayCachingPrefixes`). Several vendors publish a cache rate while OpenRouter's
//    route needs `cache_control` breakpoints nothing here emits: that figure is never metered,
//    named or derived, and reporting it is the noise that trains a reader to skim past the
//    reachable one.
//
// COVERAGE BOUNDARY: only the `openrouter:<slug>` rows. The direct-vendor rows (`openai:gpt-*`,
// `xai:*`, `qwen:*`) name no gateway route, and a gateway blend is not the vendor's own list price
// in either direction, so comparing them here would report drift against a number they are not
// held to. What keeps a direct row honest is `pricing.test.ts`, which asserts that each mirrored
// pair (`openai:X` against `openrouter:openai/X`) carries one price, band for band.
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
 * The USD to EUR factor the price table bakes in, restated here rather than imported.
 *
 * `pricing.ts` is TypeScript this plain-Node script cannot load without a build step, and the
 * factor is a documented constant of that table rather than something derived. Kept beside a
 * check that FAILS when it drifts (see `assertRateMatchesTable`), so the copy cannot rot quietly.
 */
const USD_TO_EUR = 0.92

/**
 * The rate fields, mapped to the `/models` pricing key each is read against, to the
 * `CACHE_*_MULTIPLIER` the table falls back to when a band leaves the field out, and to the
 * fallback key a vendor may publish the class under instead.
 *
 * `multiplier` is what makes the two cache classes comparable at all: a band names one only where
 * the vendor departs from the floor, so most rows have no cache number of their own and the budget
 * meters them at that band's `inputPerMillion` times this factor. Comparing the named value alone
 * checks the minority of rows and calls the majority clean. It doubles as the marker for a CACHE
 * class, which is the one the reachability gate narrows.
 *
 * `fallbackPriceKey` mirrors `cacheWriteRate` in `openRouterModels.ts`: a model that publishes only
 * the 1-hour TTL states its write rate under `input_cache_write_1h`, and reading the 5-minute key
 * alone leaves that route comparing against `undefined`, which is the same silent pass as not
 * comparing it at all. Preferred in that order rather than folded to a maximum, because which TTL
 * the harnesses request IS known (the default 5-minute one), the same reasoning that fixes
 * `CACHE_WRITE_MULTIPLIER` at 1.25.
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
    fallbackPriceKey: 'input_cache_write_1h',
    multiplier: 'CACHE_WRITE_MULTIPLIER',
  },
]

/**
 * The body of the object literal opening at `openIndex`, with comments REMOVED and nested braces
 * kept.
 *
 * Balanced-brace scanning rather than a `[^}]*` regex, and the difference is not theoretical in
 * either file this script reads. `GATEWAY_PREFIX_POLICY` carries a `{@link providerCachePolicy}`
 * reference in a comment BETWEEN its entries, so a first-`}` match ends the map mid-way and every
 * vendor declared below that line is invisible; a price row carries a nested `longBand: { ... }`,
 * so the same match ends the row at the band's closing brace. Both failures are silent, and both
 * silence a comparison rather than breaking one.
 *
 * Comments come out because a commented-out rate inside a row would otherwise read as the row's
 * own, and prose inside the policy map can spell an entry the map does not declare.
 *
 * Returns undefined for an unbalanced literal, which every caller turns into a throw: this script
 * refuses to grade against a source it could not read.
 */
export function objectLiteralBody(source, openIndex) {
  if (source[openIndex] !== '{') return undefined
  let depth = 0
  let body = ''
  let i = openIndex
  while (i < source.length) {
    const pair = source.slice(i, i + 2)
    if (pair === '//') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end + 1
      body += '\n'
      continue
    }
    if (pair === '/*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      body += ' '
      continue
    }
    const ch = source[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = endOfString(source, i)
      body += source.slice(i, end)
      i = end
      continue
    }
    if (ch === '{') depth++
    if (ch === '}' && --depth === 0) return body.slice(1)
    body += ch
    i++
  }
  return undefined
}

/** The index just past the string literal starting at `start`, escapes included. */
function endOfString(source, start) {
  const quote = source[start]
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++
      continue
    }
    if (source[i] === quote) return i + 1
  }
  return source.length
}

/**
 * A nested `key: { ... }` lifted out of an object body: its own body, plus the body with that
 * whole property removed.
 *
 * The removal is what keeps the outer read honest. `readNumber` matches the first occurrence of a
 * field name, and a nested band states the same field names as the row around it, so leaving the
 * band in place makes which band's rate is read a matter of which one happens to be written first.
 */
export function splitNested(body, key) {
  const at = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(body)
  if (!at) return { rest: body }
  const openIndex = at.index + at[0].length - 1
  const inner = objectLiteralBody(body, openIndex)
  if (inner === undefined) {
    // Only reachable for a body that is not itself a balanced literal, since a balanced one
    // cannot contain an unbalanced one. A throw rather than a fallback all the same: returning
    // the body whole would read the nested band's rates as the surrounding row's own.
    throw new Error(`A '${key}' property does not close its object literal.`)
  }
  return { inner, rest: body.slice(0, at.index) + body.slice(openIndex + inner.length + 2) }
}

/** Pull the pinned `openrouter:<slug>` rows and their per-band rates out of the price table. */
export function readPinnedSlugs(source) {
  const pins = []
  const rowRe = /'openrouter:([^']+)'\s*:\s*\{/g
  let match
  while ((match = rowRe.exec(source)) !== null) {
    const slug = match[1]
    const body = objectLiteralBody(source, rowRe.lastIndex - 1)
    if (body === undefined) throw unreadableRow(slug, 'does not close its object literal')
    const { inner, rest } = splitNested(body, 'longBand')
    const pin = { slug, ...readRates(rest) }
    if (inner !== undefined) {
      pin.longBand = {
        minPromptTokens: readThreshold(inner, source, slug),
        ...readRates(inner),
      }
    }
    pins.push(pin)
  }
  return pins
}

function unreadableRow(slug, what) {
  return new Error(
    `${PRICING_FILE}: the 'openrouter:${slug}' row ${what}. The pins cannot be read until this ` +
      'script reads the new shape.',
  )
}

/** The four rate fields of one band, as written (an absent field stays undefined, never 0). */
function readRates(body) {
  const rates = {}
  for (const { field } of RATE_FIELDS) rates[field] = readNumber(body, field)
  return rates
}

function readNumber(body, key) {
  const found = new RegExp(`${key}\\s*:\\s*([0-9][0-9_]*(?:\\.[0-9]+)?|\\.[0-9]+)`).exec(body)
  return found ? Number(found[1].replace(/_/g, '')) : undefined
}

/**
 * A band's `minPromptTokens`, resolving the NAMED CONSTANT the table states it as.
 *
 * The rates are literals on their own line; a threshold is one vendor-wide rule shared by ten
 * entries, so the table names it (`OPENAI_LONG_CONTEXT_TOKENS`) rather than repeating the number.
 * Reading the line alone therefore finds an identifier, and leaving it at `undefined` would
 * withhold the threshold comparison for every row that has one while the report still says
 * "nothing to do". Resolved out of the same source instead, the way `readCacheMultipliers` reads
 * the two cache factors, and a constant that is not a plain literal is a throw for the same
 * reason: it is a check silently not running.
 */
function readThreshold(body, source, slug) {
  const found = new RegExp(
    `minPromptTokens\\s*:\\s*([A-Za-z_$][\\w$]*|[0-9][0-9_]*(?:\\.[0-9]+)?)`,
  ).exec(body)
  if (!found) throw unreadableRow(slug, 'declares a longBand with no minPromptTokens')
  const raw = found[1]
  if (/^[0-9]/.test(raw)) return Number(raw.replace(/_/g, ''))
  const declared = new RegExp(`\\b${raw}\\s*=\\s*([0-9][0-9_]*(?:\\.[0-9]+)?)`).exec(source)
  if (!declared) {
    throw unreadableRow(
      slug,
      `states its band threshold as ${raw}, which is not declared with a literal value in this file`,
    )
  }
  return Number(declared[1].replace(/_/g, ''))
}

/**
 * The `CACHE_*_MULTIPLIER` factors, READ OUT of the price table rather than restated here.
 *
 * The USD to EUR factor above is a copy guarded by a prose check, and that shape is only defensible
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
  const at = /GATEWAY_PREFIX_POLICY[^={]*=\s*\{/.exec(source)
  const body = at ? objectLiteralBody(source, at.index + at[0].length - 1) : undefined
  if (body === undefined) {
    throw new Error(
      `${CACHE_POLICY_FILE} no longer declares a GATEWAY_PREFIX_POLICY object literal. The ` +
        'derived cache rates cannot be checked until this script reads the new shape.',
    )
  }
  const prefixes = new Set()
  const entryRe = /'?([a-zA-Z0-9_-]+)'?\s*:\s*'([a-z-]+)'/g
  let entry
  while ((entry = entryRe.exec(body)) !== null) {
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

/** USD per token (OpenRouter's string form) to EUR per million, the unit the table states. */
export function eurPerMillion(usdPerToken) {
  if (usdPerToken === undefined || usdPerToken === null || usdPerToken === '') return undefined
  const n = Number(usdPerToken)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 1_000_000 * USD_TO_EUR * 10_000) / 10_000
}

/**
 * The conditional bands the route publishes beside its base pricing.
 *
 * The `Array.isArray` guard is the one `parseOpenRouterModels` applies to the same field, for the
 * same reason: `overrides` is whatever the payload said. A non-array would spread into characters
 * (a string) or throw on `.map` (an object), and a throw here exits 1, which is this script's
 * reserved "a pinned route was withdrawn" signal. An unreadable payload must not read as a
 * withdrawal.
 */
function bands(pricing) {
  const overrides = pricing?.overrides
  return Array.isArray(overrides) ? overrides : []
}

/**
 * The rate the route bills this class at in its BASE band: the price beside the model, before any
 * conditional band applies. What a row's own base rates are answerable for.
 */
export function baseBandRate(pricing, priceKey, fallbackPriceKey) {
  return (
    eurPerMillion(pricing?.[priceKey]) ??
    (fallbackPriceKey === undefined ? undefined : eurPerMillion(pricing?.[fallbackPriceKey]))
  )
}

/**
 * The DEAREST rate a route can bill this class at: its base rate, or a long-context band where the
 * gateway publishes one.
 *
 * Several models bill in two bands, where a prompt past a threshold reprices the WHOLE request:
 * OpenAI at 272K input tokens, Gemini 3.1 Pro and Grok 4.6 at 200K. OpenRouter states each as an
 * `overrides: [{ min_prompt_tokens, ... }]` entry beside the base pricing. A row stating ONE price
 * has to cover this figure whatever prompt a run sends, so it is what such a row is compared
 * against; a row carrying a `longBand` covers each band separately.
 *
 * The same fold, for the same stated reason, is what the DYNAMIC per-workspace overlay applies
 * (`dearestRate` in `openRouterModels.ts`), which has no prompt size to read either.
 */
export function dearestBandRate(pricing, priceKey, fallbackPriceKey) {
  return foldDearest(pricing, priceKey) ?? foldDearest(pricing, fallbackPriceKey)
}

function foldDearest(pricing, priceKey) {
  if (priceKey === undefined) return undefined
  const published = [pricing?.[priceKey], ...bands(pricing).map((b) => b?.[priceKey])]
  const rates = published.map(eurPerMillion).filter((r) => r !== undefined)
  return rates.length === 0 ? undefined : Math.max(...rates)
}

/**
 * The lowest prompt size at which the route stops billing its base band, or undefined where it
 * publishes no conditional band at all.
 *
 * The LOWEST rather than the one nearest ours: a row's threshold has to be at or below the point
 * the vendor starts charging more, and a route publishing several bands starts at the first.
 */
export function lowestBandThreshold(pricing) {
  const thresholds = bands(pricing)
    .map((b) => b?.min_prompt_tokens)
    .filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0)
  return thresholds.length === 0 ? undefined : Math.min(...thresholds)
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

/** Whether `metered` sits materially below `live`; see {@link UNDERSTATEMENT_TOLERANCE}. */
function understates(metered, live) {
  if (live === undefined || metered === undefined || live <= 0) return false
  return metered < live * (1 - UNDERSTATEMENT_TOLERANCE)
}

/**
 * The rate a budget would actually meter this class at in one band: the number the band names,
 * else the one the table derives from that band's own input rate.
 *
 * Returns `undefined` where there is nothing to compare, and the reasons for that are different
 * facts kept apart on purpose. A class with no multiplier (input, output) has no derived form, so
 * an absent number is an absent row. A CACHE class on a route that does not cache on a request
 * this platform builds is never metered AT ALL, named or derived: no hit lands, so comparing the
 * figure against a published rate would be a finding about arithmetic rather than about money.
 * `pricing.test.ts` holds the other half of that agreement, refusing a pinned cache rate whose
 * route the policy map has never been asked about.
 */
export function effectiveRate(band, spec, { slug, cacheMultipliers, cachingPrefixes }) {
  if (spec.multiplier && !cachingPrefixes.has(vendorPrefix(slug))) return undefined
  const named = band[spec.field]
  if (named !== undefined) return { rate: named, derived: false }
  if (!spec.multiplier || band.inputPerMillion === undefined) return undefined
  return { rate: band.inputPerMillion * cacheMultipliers[spec.multiplier], derived: true }
}

/**
 * The bands of one pin, each with the live figure it is answerable for.
 *
 * A row carrying a `longBand` covers two: its base rates against what the route bills before any
 * threshold, and the band against the dearest thing the route bills at all. A row carrying ONE
 * price is compared once, against the dearest, because it has no second slot for a long prompt to
 * be metered in. Running both comparisons on such a row would report every field twice.
 */
function pinBands(pin) {
  if (!pin.longBand) return [{ prefix: '', rates: pin, live: dearestBandRate }]
  return [
    { prefix: '', rates: pin, live: baseBandRate },
    { prefix: 'longBand.', rates: pin.longBand, live: dearestBandRate },
  ]
}

/**
 * Compare each pin against the live catalogue.
 *
 * `served` / `withdrawn` answer "is this route still there"; `understated` answers "would this row
 * UNDER-charge a budget", and `lateBands` asks that of a threshold rather than of a rate. Only the
 * first can fail the run, for the reason in the header: the table is meant to sit above the live
 * rate, so overstating is the design and understating is the bug.
 *
 * `cacheMultipliers` and `cachingPrefixes` come from the two source reads rather than from
 * defaults, so a caller that skipped them would silently check less than it appears to.
 */
export function comparePins(pins, catalogue, { cacheMultipliers, cachingPrefixes }) {
  const served = []
  const withdrawn = []
  const understated = []
  const lateBands = []
  for (const pin of pins) {
    const model = catalogue.get(pin.slug)
    if (!model) {
      withdrawn.push({ ...pin, nearMatches: nearMatches(pin.slug, catalogue) })
      continue
    }
    served.push(pin.slug)
    const under = understatedFields(pin, model.pricing, { cacheMultipliers, cachingPrefixes })
    if (under.length > 0) understated.push({ slug: pin.slug, fields: under })
    const late = lateBand(pin, model.pricing)
    if (late) lateBands.push({ slug: pin.slug, ...late })
  }
  return { served, withdrawn, understated, lateBands }
}

/**
 * Every class of every band where this row meters below what the route bills.
 *
 * Only a rate materially BELOW the live one is reported: a budget metering less than the call
 * costs. Above it is the table's intended margin and says nothing.
 */
function understatedFields(pin, pricing, options) {
  const under = []
  for (const { prefix, rates, live } of pinBands(pin)) {
    for (const spec of RATE_FIELDS) {
      const effective = effectiveRate(rates, spec, { slug: pin.slug, ...options })
      const liveRate = live(pricing, spec.priceKey, spec.fallbackPriceKey)
      if (!effective || !understates(effective.rate, liveRate)) continue
      under.push({
        field: `${prefix}${spec.field}`,
        metered: effective.rate,
        live: liveRate,
        derived: effective.derived,
      })
    }
  }
  return under
}

/**
 * A pinned threshold sitting ABOVE the live one, which is the same undercount as a rate: every
 * request between the two meters in the base band the vendor has stopped billing. Below the live
 * one is the conservative direction and says nothing, as with every other figure here.
 */
function lateBand(pin, pricing) {
  const pinned = pin.longBand?.minPromptTokens
  const live = lowestBandThreshold(pricing)
  if (pinned === undefined || live === undefined || pinned <= live) return undefined
  return { pinned, live }
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

/** Fetch the live catalogue as a slug-to-model map. No API key: `/models` answers unauthenticated. */
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
        lines.push(`  ${slug} ${f.field}: ${f.metered}, live ${f.live} (EUR/1M)${how}`)
      }
    }
    lines.push(
      '',
      'Advisory. The table is deliberately conservative, so sitting ABOVE the live rate is the',
      'design; only these UNDER-charge a budget. Enabling the model in a workspace’s OpenRouter',
      'catalog overrides the table entirely. A [derived] finding is fixed by NAMING the class on',
      'that band, not by moving the input rate every other class of the band follows.',
    )
  }
  if (result.lateBands.length > 0) {
    lines.push(
      '',
      `Late band (${result.lateBands.length}): the row keeps billing its base rates past the point`,
      'the route reprices:',
    )
    for (const b of result.lateBands) {
      lines.push(`  ${b.slug} longBand.minPromptTokens: ${b.pinned}, live ${b.live} tokens`)
    }
    lines.push(
      '',
      'Advisory, and the same undercount as a rate: every request between the two thresholds',
      'meters in a band the vendor has stopped charging. Lower the pin to the live figure.',
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
