---
'@cat-factory/acceptance-kit': patch
'@cat-factory/app': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
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

Price every two-band model at the band a long prompt is really billed at, check the cache classes
the table DERIVES, take the agent CLIs at their newest, and refresh the dependency tree.

**Six rows were metering a long-context request at half its input rate.** OpenAI bills a request
whose prompt reaches 272,000 input tokens entirely at roughly double the short rate, with no
blending, and Gemini 3.1 Pro does the same at 200,000 tokens. Every OpenAI row and the Gemini Pro
row carried the SHORT band, so a long-prompt run metered at half its input and around 60% of its
output. The catalog gives all six entries a window over a million tokens, so a container agent
re-sending a large checkout crosses that threshold as ordinary behaviour, not as an edge case.

All six now carry the long band, which is the decision the `xai:grok-4.6` row beside them already
made and states at length, and it is also the rule the DYNAMIC per-workspace OpenRouter overlay
has been applying all along: `dearestRate` folds a model's conditional bands to their maximum
because which band applies depends on the prompt actually sent, which nobody knows at refresh time.
The static table and the pin checker were the two places that rule had not reached, so a static
row contradicted the path it sits behind. A short-prompt run is over-metered as the accepted cost,
which is the direction a budget safeguard is allowed to be wrong in.

**A DERIVED cache rate can understate the live one, and nothing was checking it.** A row names a
cache rate only where the vendor departs from the `CACHE_*_MULTIPLIER` floor, and
`check-openrouter-pins.mjs` skipped every unnamed class on the grounds that a derived figure has no
pin to have drifted. The derived figure is still what the budget meters with, and it follows OUR
input rate rather than the vendor's cache rate: `openrouter:z-ai/glm-5.3` was metering cache reads
at 54% of the live rate while the report said "nothing to do", on the class a container agent's
re-sent prefix lands in every turn. That row now names its rate, and the check compares the
EFFECTIVE rate for four classes rather than the pinned numbers for three.

Two things keep that from becoming noise. A derived cache class is compared only where a hit can
actually land on the route, read out of the contracts `GATEWAY_PREFIX_POLICY` rather than restated,
because several vendors publish a cache rate on a route that needs `cache_control` breakpoints
nothing here emits. And the live side is now the dearest band a route publishes, which is what
turned the six rows above from clean to understated.

`openrouter:moonshotai/kimi-k2.7-code` is re-pinned from $0.674 / $3.40 to the $0.71 / $3.50 the
gateway's blend reads today. The DeepSeek alias rows are re-stamped and deliberately not moved:
both now sit above their live rate, and Pro has swung $0.556 to $1.60 to $0.946 across three reads
in a fortnight, so chasing that blend down would spend the table's margin on noise.

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
The executor image tag rolls to 1.156.0.

Dependency refresh: direct ranges plus a lockfile re-resolution, 75 resolved names moved, no
package name added or dropped, and three names that had two copies now have one. `@clack/prompts`
1.8.0 needed one source change: `isCancel` now narrows to a UNIQUE symbol while the prompts still
return the wide `symbol`, so control flow can no longer subtract one from the other, and the CLI's
single cancel seam says so where it asserts. Four holds are unchanged and were re-verified at HEAD:
vitest at 4.1.11 and wrangler at 4.124.0 (vitest-pool-workers 0.22.0 is still newest, peers
`vitest: ^4.1.0` and pins that wrangler exactly), `@cloudflare/workers-types` at 5.20260815.1 (the
resolved workerd's date), and frontend TypeScript at 6.0.3 (vue-tsc 3.3.11 is still newest and
calls `require.resolve('typescript/lib/tsc')`, absent from TS 7's exports map). Actions:
changesets/action v2.1.1 to v2.1.2, the only one that moved.
