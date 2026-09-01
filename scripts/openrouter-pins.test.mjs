// Fixtures for the OpenRouter pin check's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// The guard makes a network call, so its real run is on the weekly cadence rather than per-PR.
// That makes ITS OWN logic the thing most likely to rot unnoticed: a parser that quietly matched
// nothing would report "Checked 0 pins" as a pass on a check whose whole job is to notice a
// withdrawn route. Two extractors carry that weight: the one that reads the pins out of the
// TypeScript price table (it cannot import the module, so it reads the source), and the one that
// converts OpenRouter's USD-per-token strings into the EUR-per-million unit the table states.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { comparePins, eurPerMillion, readPinnedSlugs } from './check-openrouter-pins.mjs'

/** A slice of the price table in the shape the real file uses, including a multi-line row. */
const PRICING_SOURCE = `
  'openrouter:anthropic/claude-opus-5': { inputPerMillion: 4.6, outputPerMillion: 23 },
  // A comment between rows, as the real table has plenty of.
  'openrouter:deepseek/deepseek-v4-flash': {
    inputPerMillion: 0.25,
    outputPerMillion: 1,
    cacheReadPerMillion: 0.025,
  },
  'openrouter:z-ai/glm-5.2': { inputPerMillion: 1.29, outputPerMillion: 4.05 },
  openrouter: { inputPerMillion: 1.84, outputPerMillion: 11.04 },
  'anthropic:claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
`

test('reads every pinned openrouter slug, across single- and multi-line rows', () => {
  const pins = readPinnedSlugs(PRICING_SOURCE)
  assert.deepEqual(
    pins.map((p) => p.slug),
    ['anthropic/claude-opus-5', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.2'],
  )
  assert.deepEqual(pins[1], {
    slug: 'deepseek/deepseek-v4-flash',
    inputPerMillion: 0.25,
    outputPerMillion: 1,
    cacheReadPerMillion: 0.025,
  })
  // A row that names no cache rate leaves it undefined rather than 0: the table DERIVES that
  // class, so there is no pinned number for the drift report to compare.
  assert.equal(pins[0].cacheReadPerMillion, undefined)
})

test('ignores the bare per-provider fallback row and other providers entirely', () => {
  // `openrouter:` with no slug is the per-PROVIDER fallback, not a pin. Checking it against the
  // catalogue would report the fallback itself as a withdrawn model on every run.
  const slugs = readPinnedSlugs(PRICING_SOURCE).map((p) => p.slug)
  assert.equal(slugs.includes(''), false)
  assert.equal(
    slugs.some((s) => s.startsWith('claude-opus')),
    false,
  )
})

test('converts USD per token to EUR per million at the factor the table bakes in', () => {
  // The unit is the whole risk here: getting it wrong is a 1,000,000x error in a drift report.
  assert.equal(eurPerMillion('0.000005'), 4.6)
  assert.equal(eurPerMillion('0'), 0)
  // Not a rate: absent, rather than coerced to a number the report would then compare against.
  assert.equal(eurPerMillion(undefined), undefined)
  assert.equal(eurPerMillion(''), undefined)
  assert.equal(eurPerMillion('free'), undefined)
  assert.equal(eurPerMillion('-1'), undefined)
})

/** A live catalogue in the shape `/models` returns, keyed by slug. */
function catalogue(entries) {
  return new Map(
    entries.map(([id, prompt, completion, inputCacheRead]) => [
      id,
      {
        id,
        pricing: {
          prompt,
          completion,
          ...(inputCacheRead === undefined ? {} : { input_cache_read: inputCacheRead }),
        },
      },
    ]),
  )
}

test('separates a served pin from a withdrawn one', () => {
  const pins = readPinnedSlugs(PRICING_SOURCE)
  const live = catalogue([
    ['anthropic/claude-opus-5', '0.000005', '0.000025'],
    ['z-ai/glm-5.2', '0.0000014', '0.0000044'],
  ])
  const result = comparePins(pins, live)
  assert.deepEqual(result.served.sort(), ['anthropic/claude-opus-5', 'z-ai/glm-5.2'])
  assert.deepEqual(
    result.withdrawn.map((p) => p.slug),
    ['deepseek/deepseek-v4-flash'],
  )
})

test('offers same-vendor near matches as a lead, never a repin', () => {
  const pins = readPinnedSlugs(
    "'openrouter:deepseek/deepseek-v4-flash': { inputPerMillion: 1, outputPerMillion: 2 },",
  )
  const live = catalogue([
    ['deepseek/deepseek-v4-flash-0731', '0.000001', '0.000002'],
    ['deepseek/deepseek-v3.2', '0.000001', '0.000002'],
    // Same model stem, DIFFERENT vendor: a gateway re-hosting is not the same route.
    ['other/deepseek-v4-flash', '0.000001', '0.000002'],
  ])
  const [withdrawn] = comparePins(pins, live).withdrawn
  assert.deepEqual(withdrawn.nearMatches, [
    'deepseek/deepseek-v3.2',
    'deepseek/deepseek-v4-flash-0731',
  ])
})

test('reports a pin that meters BELOW the live rate and stays quiet about one above it', () => {
  // The asymmetry is the point: the table carries a deliberate conservative margin, so sitting
  // above the live rate is the design and only an understatement under-charges a budget.
  const pins = readPinnedSlugs(`
    'openrouter:cheap/model': { inputPerMillion: 0.1, outputPerMillion: 0.2 },
    'openrouter:dear/model': { inputPerMillion: 100, outputPerMillion: 200 },
  `)
  const live = catalogue([
    // Input understates the live rate (0.1 pinned against 0.92 live); output does not.
    ['cheap/model', '0.000001', '0.0000001'],
    ['dear/model', '0.000001', '0.000002'],
  ])
  const { understated } = comparePins(pins, live)
  assert.deepEqual(understated, [
    {
      slug: 'cheap/model',
      fields: [{ field: 'inputPerMillion', pinned: 0.1, live: 0.92 }],
    },
  ])
})

test('reports a pinned CACHE READ rate that has drifted under the live one', () => {
  // The class this check exists for. A row names `cacheReadPerMillion` only where the vendor
  // departs from the derived 0.1x floor, so nothing else follows it when the vendor moves: the
  // input rate can be perfectly current while every cached token meters under. Most of a
  // container run's input tokens are cache reads, so this is the drift with the largest bill.
  const pins = readPinnedSlugs(`
    'openrouter:vendor/model': {
      inputPerMillion: 1.09,
      outputPerMillion: 3.44,
      cacheReadPerMillion: 0.2,
    },
  `)
  const live = catalogue([['vendor/model', '0.00000118', '0.00000374', '0.00000022']])
  const { understated } = comparePins(pins, live)
  assert.deepEqual(understated, [
    {
      slug: 'vendor/model',
      fields: [{ field: 'cacheReadPerMillion', pinned: 0.2, live: 0.2024 }],
    },
  ])
})

test('says nothing about a class the catalogue does not price', () => {
  // A model with no published rate must not be reported as understating everything: an absent
  // live figure is not a zero to compare against.
  const pins = readPinnedSlugs(
    "'openrouter:vendor/model': { inputPerMillion: 1, outputPerMillion: 2 },",
  )
  const live = new Map([['vendor/model', { id: 'vendor/model', pricing: {} }]])
  const result = comparePins(pins, live)
  assert.deepEqual(result.served, ['vendor/model'])
  assert.deepEqual(result.understated, [])
})

test('says nothing about a cache rate the ROW does not pin', () => {
  // The mirror of the case above. The live catalogue prices the class and the table derives it,
  // so there is nothing pinned to have drifted; reporting it would put every derived row in a
  // report whose whole value is that it is short.
  const pins = readPinnedSlugs(
    "'openrouter:vendor/model': { inputPerMillion: 1, outputPerMillion: 2 },",
  )
  const live = catalogue([['vendor/model', '0.000001', '0.000002', '0.0000005']])
  assert.deepEqual(comparePins(pins, live).understated, [])
})
