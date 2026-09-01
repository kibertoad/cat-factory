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
// conservative (a fixed 0.92 EUR/USD margin, `CACHE_*_MULTIPLIER` fallbacks), so being ABOVE the
// live rate is the intended state and only a pin that now UNDERSTATES the live price is worth
// acting on. Enabling a model in the per-workspace OpenRouter catalog overrides the table entirely
// (`withDynamicPrices`), so drift is a default-quality problem, not a correctness one.
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
    pins.push({
      slug,
      inputPerMillion: readNumber(body, 'inputPerMillion'),
      outputPerMillion: readNumber(body, 'outputPerMillion'),
    })
  }
  return pins
}

function readNumber(body, key) {
  const found = new RegExp(`${key}\\s*:\\s*([0-9]*\\.?[0-9]+)`).exec(body)
  return found ? Number(found[1]) : undefined
}

/** USD per token (OpenRouter's string form) → EUR per million, the unit the table states. */
export function eurPerMillion(usdPerToken) {
  if (usdPerToken === undefined || usdPerToken === null || usdPerToken === '') return undefined
  const n = Number(usdPerToken)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 1_000_000 * USD_TO_EUR * 10_000) / 10_000
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
 * Compare each pin against the live catalogue.
 *
 * `served` / `withdrawn` answer "is this route still there"; `understated` answers "would this pin
 * UNDER-charge a budget". Only the first can fail the run, for the reason in the header: the table
 * is meant to sit above the live rate, so overstating is the design and understating is the bug.
 */
export function comparePins(pins, catalogue) {
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
    const liveInput = eurPerMillion(model.pricing?.prompt)
    const liveOutput = eurPerMillion(model.pricing?.completion)
    // Only a pin materially BELOW the live rate is reported: a budget metering less than the call
    // costs. Above it is the table's intended margin and says nothing.
    const under = []
    if (understates(pin.inputPerMillion, liveInput)) {
      under.push({ field: 'inputPerMillion', pinned: pin.inputPerMillion, live: liveInput })
    }
    if (understates(pin.outputPerMillion, liveOutput)) {
      under.push({ field: 'outputPerMillion', pinned: pin.outputPerMillion, live: liveOutput })
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
      `Understated (${result.understated.length}): the pin meters BELOW the live rate:`,
    )
    for (const { slug, fields } of result.understated) {
      for (const f of fields) {
        lines.push(`  ${slug} ${f.field}: pinned ${f.pinned}, live ${f.live} (EUR/1M)`)
      }
    }
    lines.push(
      '',
      'Advisory. The table is deliberately conservative, so sitting ABOVE the live rate is the',
      'design; only these UNDER-charge a budget. Enabling the model in a workspace’s OpenRouter',
      'catalog overrides the table entirely.',
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
  const catalogue = await loadCatalogue(args.baseUrl, args.timeoutMs)
  const result = comparePins(pins, catalogue)
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
