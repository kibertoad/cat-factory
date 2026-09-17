---
'@cat-factory/acceptance': patch
'@cat-factory/acceptance-kit': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/consensus': patch
'@cat-factory/deploy-harness': minor
'@cat-factory/eks': patch
'@cat-factory/executor-harness': minor
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/local-server': patch
'@cat-factory/mcp-server': patch
'@cat-factory/node-server': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/sdk': patch
'@cat-factory/server': patch
'@cat-factory/spend': patch
'@cat-factory/worker': patch
---

Take the agent CLIs at their newest, correct the one under-metering price row, and refresh the
dependency tree.

**Re-verified every catalog route against its serving provider, and the catalog needed nothing.**
Anthropic, OpenAI, Google, xAI, DeepSeek, Moonshot, Z.ai, Alibaba and Cloudflare Workers AI were
each read fresh. Every model this catalog selects is still served under the id it names, and every
frontier launch since the last sweep is already here, so the honest result is no entry added and
none retired. Claude Mythos 5.1 stays out for the reason it always has: invitation-only through
Project Glasswing, with no public route to declare. What is new elsewhere is a cheaper or smaller
tier of something already carried (Gemini 3.5 Flash-Lite, GPT-5.4, Grok 4.3, a `-highspeed`
variant of Kimi K2.7 Code, `@cf/qwen/qwen3.8-27b` and `@cf/openai/gpt-oss-20b` on Workers AI), and
a tier nothing here would route to does not earn a catalog entry.

**One price row was metering below what it bills.** `check-openrouter-pins.mjs` reported
`openrouter:z-ai/glm-5.2` as the single understated pin: the gateway's blend for that slug has
finished converging on Z.ai's own $1.40 / $4.40 list, which the previous note predicted and the
numbers had not followed. Understatement is the one direction a budget gate may not sit in, so the
fresh classes move up to the figures every other GLM-5.2 row already carried. Its named cache rate
is dropped rather than re-pinned, because the gateway's $0.14/M now IS the 0.1x floor the new input
rate derives, and the retired 0.21 pin was written against a $0.26/M blend that no longer exists.
Nothing else moved: 29 of 30 pinned slugs are at or above their live rate, which is the margin the
table is for.

**Several notes were making claims that had stopped being true**, and in a table where a wrong
figure looks exactly like a right one, the reasoning is what the next reader checks the figure
against. Kimi K2.5 has left the Workers AI model index (its row stays, for recorded spend, but it
no longer "runs on Workers AI"). DeepSeek now documents `deepseek-v4-flash` as retired with the
legacy name served by `deepseek-flash`, so that row's justification narrows to the historical one.
Z.ai's GLM-5.3 Flash launch promotion has lapsed, so the row's list price is simply the price. The
Gemini Flash rate is Google's own discount to 2026-12-31, not the undiscounted rate the note
claimed, which makes it the one row deliberately below a published number and worth saying so.
OpenRouter now publishes a cache rate on both Muse Spark slugs, so the reason neither names one
moves to the half of that argument that still holds, which is about this platform, not about Meta.
The DeepSeek and Kimi gateway-blend observations are restamped with this sweep's read.

**Agent CLIs.** Claude Code moves to 2.1.274, ahead of the 24h age window, as the Dockerfile's
standing note allows for those three pins alone. Pi holds at 0.85.1 and Codex at 0.154.0, both
already newest (Codex 0.155.0 is alpha-only). The two Pi extensions move to 2.10.1, which does NOT
take that exemption and has aged past the window. The `node:26-trixie-slim` digest is unchanged:
the tag still resolves to the pinned one. Both harness images bump.

**Dependency refresh.** Direct ranges plus a lockfile re-resolution and a dedupe; no package
changed major and no name was dropped. Four holds were re-verified at HEAD rather than assumed, and
all four still bind: `@cloudflare/vitest-pool-workers@0.22.0` is newest and pins wrangler 4.124.0
exactly, which keeps wrangler, workerd, miniflare and `@cloudflare/workers-types` where they are and
keeps vitest on 4.x (the pool peers `^4.1.0`, so vitest 5 cannot be taken); drizzle stays on its
1.0.0-rc line; the frontend stays on TypeScript 6 for `vue-tsc`. Three Docker GitHub Actions move to
their newest aged releases.

One bump was a source change rather than a number. `@clack/prompts` 1.8.1 respells every prompt's
result from `Promise<Value | symbol>` to `Promise<Value | typeof CANCEL_SYMBOL>`, and the CLI's
`bailIfCancelled` was declared `(value: T | symbol): T` so that inference would peel the symbol arm
off. A unique symbol does not match a wide `symbol` parameter slot, so under the new spelling `T`
swallowed the union whole and four call sites went back to holding a symbol they thought they had
been rid of — a typecheck failure here, but the same shape that reaches `.trim()` at runtime when it
is not. The helper now takes the whole result type and returns `Exclude<T, symbol>`, which is
indifferent to which spelling a future release uses and is what clack's own `group()` does with the
same values.
