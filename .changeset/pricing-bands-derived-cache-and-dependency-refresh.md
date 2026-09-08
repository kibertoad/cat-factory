---
'@cat-factory/acceptance-kit': patch
'@cat-factory/app': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/eks': patch
'@cat-factory/executor-harness': minor
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/local-server': patch
'@cat-factory/mcp-server': patch
'@cat-factory/node-server': patch
'@cat-factory/sdk': patch
'@cat-factory/server': patch
'@cat-factory/spend': minor
---

Meter every two-band model in the band its prompt actually lands in, check the cache classes the
table DERIVES, take the agent CLIs at their newest, and refresh the dependency tree.

**Six rows were metering a long-context request at half its input rate.** OpenAI bills a request
whose prompt reaches 272,000 input tokens entirely at roughly double the short rate, with no
blending, and Gemini 3.1 Pro does the same at 200,000 tokens. Every OpenAI row and the Gemini Pro
row carried the SHORT band, so a long-prompt run metered at half its input and around 60% of its
output. The catalog gives all six entries a window over a million tokens, so a container agent
re-sending a large checkout crosses that threshold as ordinary behaviour, not as an edge case.

**`ModelPrice` now carries both bands, and the meter picks between them.** A two-band row states
its base rates plus a `longBand` (rates, cache tiers and the threshold), `bandFor` selects on the
request's total input, and both metering entry points already hold that count: `estimateCost` gets
`inputTokens`, and `estimateClassedCost` sums the three input classes, because a vendor's threshold
is stated against the whole request and a 300K prompt served mostly from cache crosses it all the
same. Ten OpenAI rows, Gemini 3.1 Pro and the three Grok 4.6 rows carry a band, and each band's
cache tiers derive from that band's own input rate. A caller that cannot see the prompt size, which
is the telemetry rollup's rate resolver, still gets the DEARER band: of the two answers open to it,
only that one keeps a budget safe.

Pricing the whole row at the long band instead is worse in both directions the figure is read. A
short-prompt run meters at roughly double its cost, which on inline judges and estimators is the
majority of calls and trips a workspace ceiling at half its real spend. The same rows are also the
picker's informational list price, rendered with no band annotation, so GPT-6 Astra would read
18.4/69 beside Claude Fable 5 at 9.2/46 while both bill $10/$50 at ordinary prompt lengths.
`modelCostResolver` stays on the base band for that reason, and the split between `priceFor` (the
list price a human compares) and `ratesFor` (the rate a budget meters) is now stated at both.

The DYNAMIC per-workspace OpenRouter overlay still folds a model's bands to their maximum
(`dearestRate`), because which band applies depends on the prompt actually sent and a catalog
refresh has none to read. So enabling a two-band model in a workspace catalog meters its short
requests conservatively where the curated row prices each band exactly; carrying the threshold
through the catalog metadata is what would close that.

**A DERIVED cache rate can understate the live one, and nothing was checking it.** A row names a
cache rate only where the vendor departs from the `CACHE_*_MULTIPLIER` floor, and
`check-openrouter-pins.mjs` skipped every unnamed class on the grounds that a derived figure has no
pin to have drifted. The derived figure is still what the budget meters with, and it follows OUR
input rate rather than the vendor's cache rate: `openrouter:z-ai/glm-5.3` was metering cache reads
at 54% of the live rate while the report said "nothing to do", on the class a container agent's
re-sent prefix lands in every turn. That row now names its rate, and the check compares the
EFFECTIVE rate for four classes rather than the pinned numbers for three.

Three things keep that from becoming noise. A cache class is compared only where a hit can actually
land on the route, read out of the contracts `GATEWAY_PREFIX_POLICY` rather than restated, and the
gate covers a NAMED rate as well as a derived one: a figure no hit reaches is inert however it was
obtained, which is what `pricing.test.ts` already records for the two Alibaba slugs. The live side
is read band for band, so a row priced correctly in both bands reports nothing rather than flagging
its short band on every run. And the pinned THRESHOLD is checked as well, against the lowest
`min_prompt_tokens` the route publishes: pinned above the live one, every request between the two
meters in a band the vendor has stopped charging.

Three parser fixes came with it, each of which silenced a comparison rather than breaking one. The
policy-map and price-row readers count braces and skip comments and strings, where a `[^}]*` match
ends the policy map at the `{@link}` reference sitting between its entries (leaving every vendor
declared below that line invisible) and would end a price row at its nested band's closing brace.
The cache-WRITE class reads `input_cache_write_1h` as a fallback, the order `cacheWriteRate`
applies on the dynamic path, so a route publishing only the long TTL is compared instead of passing
by default. And a non-array `overrides` is treated as no bands rather than thrown on, because a
throw exits 1, which is this script's reserved signal for a pinned route that was withdrawn.

`openrouter:moonshotai/kimi-k2.7-code` is re-pinned from $0.674 / $3.40 to the $0.71 / $3.50 the
gateway's blend reads today, and its named cache read to 0.18: 0.17 sat under the 0.1748 the
conversion gives by more than the checker's rounding tolerance. The two Workers AI Kimi rows that
round the same vendor figures are corrected with it. The DeepSeek alias rows are re-stamped and
deliberately not moved: both now sit above their live rate, and Pro has swung $0.556 to $1.60 to
$0.946 across three reads in a fortnight, so chasing that blend down would spend the table's margin
on noise.

**Every other rate was re-read and is unchanged**, against each vendor's own list rather than
inferred: Anthropic, the twelve Workers AI partner rows, Z.ai, Moonshot K3 and K2.6, DeepSeek's
peak bands, xAI, Qwen3.8 Max and Flash. Two prose corrections came out of it. Gemini 3.7 Flash's
half-rate promotion has lapsed on the gateway, so the row's deliberate over-count against it no
longer describes anything, and all three Flash routes now serve at the list price the rows carry.
Qwen3.8 Max is confirmed flat across its whole 1M window, unlike most of the Qwen line.

**No major model is missing.** Everything shipped between 2026-09-01 and 2026-09-04 is already in
the catalog, and every one of the 27 curated OpenRouter routes is still served at the context
window it declares. Three re-checked and still not added: GPT-6 Astra Pro carries the same
$10 / $50 short band, the same $20 / $75 long band and the same 1,050,000-token window as
`gpt-6-astra`, and OpenAI's pricing page lists no row for it, so an entry could only re-badge a
model already here; Claude Mythos 5.1 is limited-availability; and Mercury 2.5, the one text model
the gateway has gained since, is a new vendor family rather than a frontier route.

Pi holds at 0.85.1, Codex at 0.153.4 and both Pi extensions at 2.9.0, each already newest. Claude
Code goes 2.1.263 to 2.1.265, taking its newest release ahead of the 24h age window as the
Dockerfile's standing note allows. Playwright holds at 1.63.0 and WireMock at 3.13.1, both still
newest stable. `node:26-trixie-slim` still resolves to the pinned digest, so no base image moved.
The executor image tag rolls to 1.156.0, and the DEPLOY image tag to 0.6.6: the dependency refresh
reaches the deploy harness's own `@types/node` range, which is an image source, and republishing
over a live tag does not roll a deployment out.

Dependency refresh: direct ranges plus a lockfile re-resolution, 75 resolved names moved, no
package name added or dropped, and three names that had two copies now have one. `@clack/prompts`
1.8.0 needed one source change: `isCancel` narrows to a UNIQUE symbol while the prompts still
return the wide `symbol`, so control flow cannot subtract one from the other. The CLI's single
cancel seam supplies the second half itself (`isCancel(value) || typeof value === 'symbol'`), which
narrows to `T` with no assertion and also exits cleanly on a cancel symbol minted by a second copy
of `@clack/core`, where an assertion would hand that symbol back to a caller about to call `.trim()`
on it. Four holds are unchanged and were re-verified at HEAD:
vitest at 4.1.11 and wrangler at 4.124.0 (vitest-pool-workers 0.22.0 is still newest, peers
`vitest: ^4.1.0` and pins that wrangler exactly), `@cloudflare/workers-types` at 5.20260815.1 (the
resolved workerd's date), and frontend TypeScript at 6.0.3 (vue-tsc 3.3.11 is still newest and
calls `require.resolve('typescript/lib/tsc')`, absent from TS 7's exports map). Actions:
changesets/action v2.1.1 to v2.1.2, the only one that moved.
