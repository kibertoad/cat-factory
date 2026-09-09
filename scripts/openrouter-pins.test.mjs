// Fixtures for the OpenRouter pin check's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// The guard makes a network call, so its real run is on the weekly cadence rather than per-PR.
// That makes ITS OWN logic the thing most likely to rot unnoticed: a parser that quietly matched
// nothing would report "Checked 0 pins" as a pass on a check whose whole job is to notice a
// withdrawn route. Five extractors carry that weight, and four of them read a source file the
// guard cannot import: the pins and their bands out of the TypeScript price table, the
// `CACHE_*_MULTIPLIER` factors the table derives an unnamed cache rate with, the gateway vendors a
// cache hit can land on out of the contracts policy map, the balanced-brace reader all three of
// those stand on, and the converter from OpenRouter's USD-per-token strings into the
// EUR-per-million unit the table states.
//
// The last group drives the two REAL source files, because a fixture is written to the shape the
// parser expects and the shipped file is not: both parsers read the whole file, and the numbers
// they find are checked against a line-anchored count derived from the same source by a rule with
// no brace logic in it at all.

import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  comparePins,
  dearestBandRate,
  effectiveRate,
  eurPerMillion,
  lowestBandThreshold,
  objectLiteralBody,
  readCacheMultipliers,
  splitNested,
  readGatewayCachingPrefixes,
  readPinnedSlugs,
} from './check-openrouter-pins.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The two source reads `comparePins` takes, as fixtures.
 *
 * `caching` stands for a gateway vendor whose route caches automatically (`z-ai`, `moonshotai`);
 * every other vendor in this file caches nothing, which is what keeps the tests about the fresh
 * classes free of cache findings.
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

/**
 * A two-band row, the shape a vendor that reprices a whole long request gets, with the threshold
 * stated as the named constant the real table shares across every row of one vendor.
 */
const BANDED_SOURCE = `
  const OPENAI_LONG_CONTEXT_TOKENS = 272_000

  'openrouter:openai/gpt-6-astra': {
    inputPerMillion: 9.2,
    outputPerMillion: 46,
    longBand: {
      minPromptTokens: OPENAI_LONG_CONTEXT_TOKENS,
      inputPerMillion: 18.4,
      outputPerMillion: 69,
    },
  },
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

test('reads a row two bands apart, each carrying its own rates', () => {
  // The nested band is the reason this reader counts braces. A first-`}` match would end the row
  // at the band's closing brace, and reading the row's own fields by name would then take whichever
  // band happens to be written first: the two prices of one model, silently interchangeable.
  const [pin] = readPinnedSlugs(BANDED_SOURCE)
  assert.equal(pin.inputPerMillion, 9.2)
  assert.equal(pin.outputPerMillion, 46)
  assert.equal(pin.longBand.inputPerMillion, 18.4)
  assert.equal(pin.longBand.outputPerMillion, 69)
  // The threshold is a shared named constant in the real table, so the line carries an identifier
  // and not a number. Resolved out of the same source, because leaving it undefined would withhold
  // the threshold comparison for every row that has one while the report still read as clean.
  assert.equal(pin.longBand.minPromptTokens, 272_000)
  assert.equal(
    readPinnedSlugs(
      "'openrouter:v/m': { inputPerMillion: 1, outputPerMillion: 2, longBand: { minPromptTokens: 200000, inputPerMillion: 2, outputPerMillion: 4 } },",
    )[0].longBand.minPromptTokens,
    200_000,
  )
})

test('refuses a band threshold it cannot resolve to a number', () => {
  // The two ways a threshold goes missing, both of which would silence the comparison rather than
  // break it: a constant this file does not declare with a literal, and no threshold at all.
  assert.throws(
    () =>
      readPinnedSlugs(
        "'openrouter:v/m': { inputPerMillion: 1, longBand: { minPromptTokens: FROM_ELSEWHERE, inputPerMillion: 2 } },",
      ),
    /not declared with a literal value in this file/,
  )
  assert.throws(
    () =>
      readPinnedSlugs(
        "'openrouter:v/m': { inputPerMillion: 1, longBand: { inputPerMillion: 2 } },",
      ),
    /longBand with no minPromptTokens/,
  )
})

test('refuses a row whose object literal does not close, rather than skipping it', () => {
  // Silence is the failure mode this whole guard exists to rule out, so an unreadable row is a
  // throw: a skipped row reports as one fewer pin on a check nobody reads the pin count of.
  assert.throws(
    () => readPinnedSlugs("'openrouter:vendor/model': { inputPerMillion: 1,"),
    /does not close its object literal/,
  )
  // A band left open inside a row the scanner could read: only reachable by handing the nested
  // reader a body that is not a balanced literal, and still a throw, because returning the row
  // whole would read the band's rates as the row's own.
  assert.throws(
    () => splitNested('inputPerMillion: 1, longBand: { inputPerMillion: 2', 'longBand'),
    /does not close its object literal/,
  )
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

test('reads an object literal past the comments and strings inside it', () => {
  // Both source files put a brace inside a comment between entries (`{@link ...}`), and a price
  // row's keys are quoted strings that can carry one too. Either ends a `[^}]*` match early, and
  // what follows is invisible with nothing reporting a parse failure.
  const source = `const x = {
    first: 'a',
    // A comment with a brace in it: {@link somewhere}
    second: 'b}',
    nested: { third: 'c' },
  }`
  const body = objectLiteralBody(source, source.indexOf('{'))
  assert.match(body, /second/)
  assert.match(body, /nested/)
  assert.equal(body.includes('@link'), false)
  assert.equal(objectLiteralBody('const x = { unclosed: 1', 10), undefined)
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

/**
 * A live catalogue in the shape `/models` returns, keyed by slug. `extra` carries whatever else a
 * case needs on `pricing` (a cache-write rate, the conditional `overrides` bands).
 */
function catalogue(entries) {
  return new Map(
    entries.map(([id, prompt, completion, inputCacheRead, extra]) => [
      id,
      {
        id,
        pricing: {
          prompt,
          completion,
          ...(inputCacheRead === undefined ? {} : { input_cache_read: inputCacheRead }),
          ...extra,
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
      fields: [{ field: 'inputPerMillion', metered: 0.1, live: 0.92, derived: false }],
    },
  ])
})

test('reports a pinned CACHE READ rate that has drifted under the live one', () => {
  // The class this check exists for. A row names `cacheReadPerMillion` only where the vendor
  // departs from the derived 0.1x floor, so nothing else follows it when the vendor moves: the
  // input rate can be perfectly current while every cached token meters under. Most of a
  // container run's input tokens are cache reads, so this is the drift with the largest bill.
  const pins = readPinnedSlugs(`
    'openrouter:caching/model': {
      inputPerMillion: 1.09,
      outputPerMillion: 3.44,
      cacheReadPerMillion: 0.2,
    },
  `)
  const live = catalogue([['caching/model', '0.00000118', '0.00000374', '0.00000022']])
  const { understated } = comparePins(pins, live, COMPARE_OPTIONS)
  assert.deepEqual(understated, [
    {
      slug: 'caching/model',
      fields: [{ field: 'cacheReadPerMillion', metered: 0.2, live: 0.2024, derived: false }],
    },
  ])
})

test('compares the cache WRITE class, including a route that publishes only the 1-hour TTL', () => {
  // The write class is live on routes this table pins (OpenAI's and Google's gateway routes bill
  // it), and a vendor that publishes only `input_cache_write_1h` is the case a single-key read
  // calls clean: no live figure, so nothing to understate, so silence. `cacheWriteRate` in
  // `openRouterModels.ts` folds the same fallback on the dynamic path.
  const pins = readPinnedSlugs(
    "'openrouter:caching/model': { inputPerMillion: 1, outputPerMillion: 2, cacheWritePerMillion: 1.25 },",
  )
  const fiveMinute = catalogue([
    ['caching/model', '0.000001', '0.000002', undefined, { input_cache_write: '0.000002' }],
  ])
  assert.deepEqual(comparePins(pins, fiveMinute, COMPARE_OPTIONS).understated, [
    {
      slug: 'caching/model',
      fields: [{ field: 'cacheWritePerMillion', metered: 1.25, live: 1.84, derived: false }],
    },
  ])
  const oneHourOnly = catalogue([
    ['caching/model', '0.000001', '0.000002', undefined, { input_cache_write_1h: '0.000002' }],
  ])
  assert.deepEqual(comparePins(pins, oneHourOnly, COMPARE_OPTIONS).understated, [
    {
      slug: 'caching/model',
      fields: [{ field: 'cacheWritePerMillion', metered: 1.25, live: 1.84, derived: false }],
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
  // The class of gap that let `openrouter:z-ai/glm-5.3` meter cache reads at 54% of the live rate
  // while this report said "nothing to do". A row names a cache rate only where the vendor departs
  // from the floor, so an unnamed one follows OUR input rate and nothing follows the VENDOR's:
  // there is no pinned number to look stale, and the budget under-charges anyway. Checking the
  // effective rate rather than the pinned one is what makes the majority of rows checkable at all.
  const pins = readPinnedSlugs(
    "'openrouter:caching/model': { inputPerMillion: 1.29, outputPerMillion: 4.05 },",
  )
  const live = catalogue([['caching/model', '0.0000014', '0.0000044', '0.00000026']])
  assert.deepEqual(comparePins(pins, live, COMPARE_OPTIONS).understated, [
    {
      slug: 'caching/model',
      // 1.29 * 0.1, the floor the table would meter this class at. Labelled `derived` because the
      // fix is to NAME the class, not to move the input rate every other class follows.
      fields: [{ field: 'cacheReadPerMillion', metered: 0.129, live: 0.2392, derived: true }],
    },
  ])
})

test('says nothing about a cache rate on a route no hit can land on, named or derived', () => {
  // Same numbers as the case above, on a vendor whose gateway route needs `cache_control`
  // breakpoints nothing here emits. The figure exists and sits under the published rate, and it is
  // never metered because no read is ever recorded: whether the row NAMED it or derived it changes
  // the arithmetic and not the money. `meta` and `qwen` are the live examples, and `pricing.test.ts`
  // names each pinned slug in that position with the reason, so neither table is quietly assuming.
  const derived = readPinnedSlugs(
    "'openrouter:breakpoints/model': { inputPerMillion: 1.29, outputPerMillion: 4.05 },",
  )
  const named = readPinnedSlugs(`
    'openrouter:breakpoints/model': {
      inputPerMillion: 1.29,
      outputPerMillion: 4.05,
      cacheReadPerMillion: 0.129,
    },
  `)
  const live = catalogue([['breakpoints/model', '0.0000014', '0.0000044', '0.00000026']])
  assert.deepEqual(comparePins(derived, live, COMPARE_OPTIONS).understated, [])
  assert.deepEqual(comparePins(named, live, COMPARE_OPTIONS).understated, [])
})

test('an effective rate is the named number where a band states one, on a caching route', () => {
  const [named] = readPinnedSlugs(
    "'openrouter:caching/model': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.3 },",
  )
  assert.deepEqual(effectiveRate(named, RATE_SPECS.cacheRead, options(named)), {
    rate: 0.3,
    derived: false,
  })
  // ...and a class with no derived form at all is absent rather than invented.
  const [bare] = readPinnedSlugs("'openrouter:caching/model': { outputPerMillion: 2 },")
  assert.equal(effectiveRate(bare, RATE_SPECS.input, options(bare)), undefined)
})

/** The two `RATE_FIELDS` entries these unit-level cases pass, in the shape the check holds them. */
const RATE_SPECS = {
  input: { field: 'inputPerMillion', priceKey: 'prompt' },
  cacheRead: {
    field: 'cacheReadPerMillion',
    priceKey: 'input_cache_read',
    multiplier: 'CACHE_READ_MULTIPLIER',
  },
}

/** {@link COMPARE_OPTIONS} plus the slug whose route the cache gate is asked about. */
function options(pin) {
  return { slug: pin.slug, ...COMPARE_OPTIONS }
}

test('a live rate is the DEAREST band the route publishes, not its base rate', () => {
  // A two-band model reprices the WHOLE request past a prompt threshold, and a row stating one
  // price has to cover that band, so reading the base rate alone is checking the wrong number.
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

test('treats an overrides value that is not an array as no bands at all', () => {
  // `overrides` is whatever the payload said. A string would spread into characters and fold every
  // band to `undefined`; an object would throw on `.map`, and a throw exits 1, which is this
  // script's reserved "a pinned route was withdrawn" signal. Neither may happen to a live run.
  assert.equal(dearestBandRate({ prompt: '0.00001', overrides: {} }, 'prompt'), 9.2)
  assert.equal(dearestBandRate({ prompt: '0.00001', overrides: 'later' }, 'prompt'), 9.2)
  assert.equal(lowestBandThreshold({ overrides: {} }), undefined)
})

test('reports a single-price pin that covers the base band but not the long one', () => {
  // A row with one slot is answerable for the dearest band, because a long prompt has no second
  // rate to be metered at. This is the end-to-end shape a reader of the report sees.
  const pins = readPinnedSlugs(
    "'openrouter:banded/model': { inputPerMillion: 9.2, outputPerMillion: 46 },",
  )
  const live = catalogue([
    [
      'banded/model',
      '0.00001',
      '0.00005',
      undefined,
      { overrides: [{ min_prompt_tokens: 272000, prompt: '0.00002', completion: '0.000075' }] },
    ],
  ])
  assert.deepEqual(comparePins(pins, live, COMPARE_OPTIONS).understated, [
    {
      slug: 'banded/model',
      fields: [
        { field: 'inputPerMillion', metered: 9.2, live: 18.4, derived: false },
        { field: 'outputPerMillion', metered: 46, live: 69, derived: false },
      ],
    },
  ])
})

test('compares a two-band row band for band, each against the live band it answers for', () => {
  // The row states both prices, so each is checked against what the route bills in that band, and
  // the base rates are NOT held to the long band's figure: a row priced correctly in both bands
  // would otherwise report its short band as understated on every run, which is a report nobody
  // reads by the second week. The finding names the band, since the fix is a different line.
  const pins = readPinnedSlugs(`
    'openrouter:banded/model': {
      inputPerMillion: 4.6,
      outputPerMillion: 46,
      longBand: { minPromptTokens: 272000, inputPerMillion: 18.4, outputPerMillion: 46 },
    },
  `)
  const live = catalogue([
    [
      'banded/model',
      '0.00001',
      '0.00005',
      undefined,
      { overrides: [{ min_prompt_tokens: 272000, prompt: '0.00002', completion: '0.000075' }] },
    ],
  ])
  assert.deepEqual(comparePins(pins, live, COMPARE_OPTIONS).understated, [
    {
      slug: 'banded/model',
      fields: [
        // The base band understates the route's BASE rate (4.6 against 9.2), and the long band's
        // input covers the dearest exactly, so only the output half of it is reported.
        { field: 'inputPerMillion', metered: 4.6, live: 9.2, derived: false },
        { field: 'longBand.outputPerMillion', metered: 46, live: 69, derived: false },
      ],
    },
  ])
})

test('says nothing about a two-band row that covers both of its bands', () => {
  const pins = readPinnedSlugs(`
    'openrouter:banded/model': {
      inputPerMillion: 9.2,
      outputPerMillion: 46,
      longBand: { minPromptTokens: 272000, inputPerMillion: 18.4, outputPerMillion: 69 },
    },
  `)
  const live = catalogue([
    [
      'banded/model',
      '0.00001',
      '0.00005',
      undefined,
      { overrides: [{ min_prompt_tokens: 272000, prompt: '0.00002', completion: '0.000075' }] },
    ],
  ])
  assert.deepEqual(comparePins(pins, live, COMPARE_OPTIONS).understated, [])
})

test('reports a pinned THRESHOLD the vendor has moved down, and stays quiet about one below it', () => {
  // A threshold is a pinned number like a rate, and it rots the same way: pinned above the live
  // one, every request between the two meters in a base band the vendor has stopped billing. The
  // opposite direction is the conservative one and says nothing.
  const row = (threshold) => `
    'openrouter:banded/model': {
      inputPerMillion: 9.2,
      outputPerMillion: 46,
      longBand: { minPromptTokens: ${threshold}, inputPerMillion: 18.4, outputPerMillion: 69 },
    },
  `
  const live = catalogue([
    [
      'banded/model',
      '0.00001',
      '0.00005',
      undefined,
      { overrides: [{ min_prompt_tokens: 128000, prompt: '0.00002', completion: '0.000075' }] },
    ],
  ])
  assert.deepEqual(comparePins(readPinnedSlugs(row(272000)), live, COMPARE_OPTIONS).lateBands, [
    { slug: 'banded/model', pinned: 272000, live: 128000 },
  ])
  assert.deepEqual(comparePins(readPinnedSlugs(row(100000)), live, COMPARE_OPTIONS).lateBands, [])
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
  // The comment between the two groups is the shipped file's own shape, and the brace inside it is
  // what ends a `[^}]*` match: every entry below the comment is then invisible, which silences the
  // derived cache comparison for a whole vendor with nothing reporting a parse failure.
  const source = `
    const GATEWAY_PREFIX_POLICY: Readonly<Record<string, CachePolicy>> = {
      openai: 'auto-prefix',
      'z-ai': 'auto-prefix',
      // Explicit breakpoints; see {@link providerCachePolicy} for why that becomes 'none'.
      anthropic: 'explicit-anthropic',
      qwen: 'explicit-anthropic',
      google: 'auto-prefix',
    }
  `
  assert.deepEqual([...readGatewayCachingPrefixes(source)].sort(), ['google', 'openai', 'z-ai'])
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

test('finds every pinned row and every auto-caching vendor in the REAL source files', () => {
  // A fixture is written to the shape the parser expects; a shipped file is not, which is how a
  // parser passes its own tests and reads two thirds of the real map. Both expectations here are
  // derived from the same source by a line-anchored rule with no brace logic in it, so the two
  // readings can only agree if the scanner walked the whole file.
  const pricing = readFileSync(join(repoRoot, 'backend/packages/spend/src/pricing.ts'), 'utf8')
  const rowLines = pricing.match(/^\s*'openrouter:[^']+':/gm) ?? []
  assert.ok(
    rowLines.length > 20,
    `expected the shipped table to pin many routes, saw ${rowLines.length}`,
  )
  assert.equal(readPinnedSlugs(pricing).length, rowLines.length)

  const policy = readFileSync(
    join(repoRoot, 'backend/packages/contracts/src/cache-policy.ts'),
    'utf8',
  )
  const declared = (policy.match(/^\s*'?[\w-]+'?: 'auto-prefix',$/gm) ?? []).map((line) =>
    line.trim().split(':')[0].replaceAll("'", ''),
  )
  assert.ok(declared.length > 1, `expected several auto-prefix vendors, saw ${declared.length}`)
  assert.deepEqual([...readGatewayCachingPrefixes(policy)].sort(), declared.sort())
})
