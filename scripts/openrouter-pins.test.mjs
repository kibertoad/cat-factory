// Fixtures for the OpenRouter pin check's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// The guard makes a network call, so its real run is on the weekly cadence rather than per-PR.
// That makes ITS OWN logic the thing most likely to rot unnoticed: a parser that quietly matched
// nothing would report "Checked 0 pins" as a pass on a check whose whole job is to notice a
// withdrawn route. Four extractors carry that weight, and all four read a source file the guard
// cannot import: the pins out of the TypeScript price table, the `CACHE_*_MULTIPLIER` factors the
// table derives an unnamed cache rate with, the gateway vendors a cache hit can land on out of the
// contracts policy map, and the converter from OpenRouter's USD-per-token strings into the
// EUR-per-million unit the table states.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  comparePins,
  dearestBandRate,
  effectiveRate,
  eurPerMillion,
  readCacheMultipliers,
  readGatewayCachingPrefixes,
  readPinnedSlugs,
} from './check-openrouter-pins.mjs'

/**
 * The two source reads `comparePins` takes, as fixtures.
 *
 * `caching` stands for a gateway vendor whose route caches automatically (`z-ai`, `moonshotai`);
 * every other vendor in this file caches nothing, which is what keeps the tests about the fresh
 * classes free of derived cache findings.
 */
const COMPARE_OPTIONS = {
  cacheMultipliers: { CACHE_READ_MULTIPLIER: 0.1, CACHE_WRITE_MULTIPLIER: 1.25 },
  cachingPrefixes: new Set(['caching']),
}

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
    cacheWritePerMillion: undefined,
  })
  // A row that names no cache rate leaves it undefined rather than 0: undefined is what tells
  // `effectiveRate` to fall back to the table's own multiplier, where a 0 would assert the vendor
  // serves that class free.
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
  const result = comparePins(pins, live, COMPARE_OPTIONS)
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
  const [withdrawn] = comparePins(pins, live, COMPARE_OPTIONS).withdrawn
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
  const { understated } = comparePins(pins, live, COMPARE_OPTIONS)
  assert.deepEqual(understated, [
    {
      slug: 'cheap/model',
      fields: [{ field: 'inputPerMillion', pinned: 0.1, live: 0.92, derived: false }],
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
  const { understated } = comparePins(pins, live, COMPARE_OPTIONS)
  assert.deepEqual(understated, [
    {
      slug: 'vendor/model',
      fields: [{ field: 'cacheReadPerMillion', pinned: 0.2, live: 0.2024, derived: false }],
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
  const result = comparePins(pins, live, COMPARE_OPTIONS)
  assert.deepEqual(result.served, ['vendor/model'])
  assert.deepEqual(result.understated, [])
})

test('reports a DERIVED cache read that the vendor has lifted above the floor', () => {
  // The gap that let `openrouter:z-ai/glm-5.3` meter cache reads at 54% of the live rate while
  // this report said "nothing to do". A row names a cache rate only where the vendor departs from
  // the floor, so an unnamed one follows OUR input rate and nothing follows the VENDOR's: there is
  // no pinned number to look stale, and the budget under-charges anyway. Checking the effective
  // rate rather than the pinned one is what makes the majority of rows checkable at all.
  const pins = readPinnedSlugs(
    "'openrouter:caching/model': { inputPerMillion: 1.29, outputPerMillion: 4.05 },",
  )
  const live = catalogue([['caching/model', '0.0000014', '0.0000044', '0.00000026']])
  assert.deepEqual(comparePins(pins, live, COMPARE_OPTIONS).understated, [
    {
      slug: 'caching/model',
      // 1.29 * 0.1, the floor the table would meter this class at. Labelled `derived` because the
      // fix is to NAME the class, not to move the input rate every other class follows.
      fields: [{ field: 'cacheReadPerMillion', pinned: 0.129, live: 0.2392, derived: true }],
    },
  ])
})

test('says nothing about a derived cache rate on a route no hit can land on', () => {
  // Same numbers as the case above, on a vendor whose gateway route needs `cache_control`
  // breakpoints nothing here emits. The derived figure exists and is under the published rate, and
  // it is never metered, because no read is ever recorded: reporting it is noise in a report whose
  // whole value is being short. `meta` and `qwen` are the live examples.
  const pins = readPinnedSlugs(
    "'openrouter:breakpoints/model': { inputPerMillion: 1.29, outputPerMillion: 4.05 },",
  )
  const live = catalogue([['breakpoints/model', '0.0000014', '0.0000044', '0.00000026']])
  assert.deepEqual(comparePins(pins, live, COMPARE_OPTIONS).understated, [])
})

test('an effective rate is the named number where a row states one, on any route', () => {
  // The caching gate narrows the DERIVED case only. A row that names a cache rate is metering at
  // that number whatever the route does with it, so it stays comparable. Otherwise adding the
  // gate would have silenced the named findings this check already had.
  const [named] = readPinnedSlugs(
    "'openrouter:breakpoints/model': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.3 },",
  )
  assert.deepEqual(effectiveRate(named, 'cacheReadPerMillion', ...optionArgs()), {
    rate: 0.3,
    derived: false,
  })
  // …and a class with no derived form at all is absent rather than invented.
  const [bare] = readPinnedSlugs("'openrouter:caching/model': { outputPerMillion: 2 },")
  assert.equal(effectiveRate(bare, 'inputPerMillion', ...optionArgs()), undefined)
})

/** {@link COMPARE_OPTIONS} as the positional pair `effectiveRate` takes. */
function optionArgs() {
  return [COMPARE_OPTIONS.cacheMultipliers, COMPARE_OPTIONS.cachingPrefixes]
}

test('a live rate is the DEAREST band the route publishes, not its base rate', () => {
  // A two-band model reprices the WHOLE request past a prompt threshold, and the table has one
  // slot per model, so the long band is the number a pin has to cover. Reading the base rate is
  // what let five OpenAI rows and a Gemini row sit at half their long-band input and report clean.
  assert.equal(
    dearestBandRate(
      {
        prompt: '0.00001',
        overrides: [{ min_prompt_tokens: 272000, prompt: '0.00002' }],
      },
      'prompt',
    ),
    18.4,
  )
  // A single-band route has nothing to take a maximum over.
  assert.equal(dearestBandRate({ prompt: '0.00001' }, 'prompt'), 9.2)
  // A band that prices fewer classes than the base does must not erase the base's own figure: the
  // maximum is taken over the bands that state THIS class, and an absent one is not a zero.
  assert.equal(
    dearestBandRate({ prompt: '0.00001', overrides: [{ min_prompt_tokens: 200000 }] }, 'prompt'),
    9.2,
  )
  assert.equal(dearestBandRate({ overrides: [] }, 'prompt'), undefined)
})

test('reports a pin that covers the base band but not the long one', () => {
  // The end-to-end shape of the case above, which is what a reader of the report actually sees.
  const pins = readPinnedSlugs(
    "'openrouter:banded/model': { inputPerMillion: 9.2, outputPerMillion: 46 },",
  )
  const live = new Map([
    [
      'banded/model',
      {
        id: 'banded/model',
        pricing: {
          prompt: '0.00001',
          completion: '0.00005',
          overrides: [{ min_prompt_tokens: 272000, prompt: '0.00002', completion: '0.000075' }],
        },
      },
    ],
  ])
  assert.deepEqual(comparePins(pins, live, COMPARE_OPTIONS).understated, [
    {
      slug: 'banded/model',
      fields: [
        { field: 'inputPerMillion', pinned: 9.2, live: 18.4, derived: false },
        { field: 'outputPerMillion', pinned: 46, live: 69, derived: false },
      ],
    },
  ])
})

test('reads the cache multipliers out of the price table, and refuses a table without them', () => {
  // A copy of these two would compute a floor the budget never uses, so they are read. A default
  // would be the silent pass the whole guard exists to rule out, one level down.
  assert.deepEqual(
    readCacheMultipliers(
      'export const CACHE_READ_MULTIPLIER = 0.1\nexport const CACHE_WRITE_MULTIPLIER = 1.25\n',
    ),
    { CACHE_READ_MULTIPLIER: 0.1, CACHE_WRITE_MULTIPLIER: 1.25 },
  )
  assert.throws(
    () => readCacheMultipliers('export const CACHE_READ_MULTIPLIER = someOtherConstant\n'),
    /no longer exports CACHE_READ_MULTIPLIER/,
  )
})

test('reads only the AUTO-CACHING gateway vendors out of the contracts policy map', () => {
  // `explicit-anthropic` is downgraded to `none` for a gateway by `providerCachePolicy`, because
  // nothing on this path emits the breakpoints, so it must not count as a route that caches here.
  const source = `
    const GATEWAY_PREFIX_POLICY: Readonly<Record<string, CachePolicy>> = {
      openai: 'auto-prefix',
      'z-ai': 'auto-prefix',
      anthropic: 'explicit-anthropic',
      qwen: 'explicit-anthropic',
    }
  `
  assert.deepEqual([...readGatewayCachingPrefixes(source)].sort(), ['openai', 'z-ai'])
})

test('refuses a policy map it cannot read rather than silencing every derived check', () => {
  // Both failures are the same bug wearing two hats: a map that moved, and a run that would then
  // report "nothing to do" about a class it never compared.
  assert.throws(
    () => readGatewayCachingPrefixes('const GATEWAY_PREFIX_POLICY = buildPolicy()\n'),
    /no longer declares a GATEWAY_PREFIX_POLICY object literal/,
  )
  assert.throws(
    () =>
      readGatewayCachingPrefixes("const GATEWAY_PREFIX_POLICY = { qwen: 'explicit-anthropic' }"),
    /declares no 'auto-prefix' gateway vendor/,
  )
})
