---
'@cat-factory/acceptance': patch
'@cat-factory/acceptance-kit': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/binary-generators': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/conformance': patch
'@cat-factory/consensus': patch
'@cat-factory/contracts': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/eks': patch
'@cat-factory/example-custom-agent': patch
'@cat-factory/executor-harness': minor
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': minor
'@cat-factory/local-server': patch
'@cat-factory/mcp-server': patch
'@cat-factory/node-server': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/sandbox-fixtures': patch
'@cat-factory/sdk': patch
'@cat-factory/server': patch
'@cat-factory/spend': minor
'@cat-factory/worker': patch
---

Re-point the DeepSeek Flash route at the model DeepSeek actually serves, take the agent CLIs at
their newest, and refresh the dependency tree.

**A retired model behind a live alias.** DeepSeek retired V4-Flash and V4-Flash-Vision-Exp on
2026-09-10 and made `deepseek-flash` the canonical, unversioned name for V4.1-Flash. The old
`deepseek-v4-flash` id still resolves, but only as a TEMPORARY compatibility alias onto the new
model, which is the quietest shape this catalog's failures take: nothing throws and nothing fails
to dispatch, so the picker went on saying "DeepSeek V4 Flash" while a different model answered, at
a rate the spend table did not carry, and the route dies outright whenever the alias is withdrawn.
All three DeepSeek-served arms of the `deepseek` entry (direct, subscription, and the OpenRouter
one, which must name the same model or the entry straddles two) now name the live model. The entry
keeps its `deepseek` id: that id is what a workspace persists against a block, and this is the same
slot following the vendor's own successor, so re-minting it would invalidate every stored pick to
say nothing new. `acceptsImages` is new on both refs and is a real capability gain rather than a
correction, since V4.1-Flash folds the vision line back into the main model.

Two adjacent claims were re-read rather than trusted. The 2026-09-10 release note said
`deepseek-v4-pro` would route to V4.1-Flash from 2026-09-14, which would have silently demoted that
entry to a cheaper, weaker model; DeepSeek has since decided to keep serving V4 Pro with billing
unchanged, so it is untouched. And OpenRouter still serves a separate `deepseek/deepseek-v4-flash`
at a fifth of the price, which this entry deliberately does not keep: it is the retired build, and
an entry whose direct and gateway arms named different models is the neighbouring-version trap the
catalog header bans. Both retired price keys stay in the table so historical spend rows keep
costing correctly.

**No other catalog gap.** Every frontier launch since the last sweep was checked against its
serving provider and is already here: Claude Fable 5.1, Gemini 3.8 Flash, Muse Spark 1.3 and GPT-6
Astra. Claude Mythos 5.1 stays out on purpose. It is the same model as Fable 5.1 at identical
pricing, offered by invitation only through Project Glasswing with no public route on any provider
this platform reaches, so an entry could only be a re-badge that `effectiveVariant` would pick and
then fail to dispatch. "Astra Pro" stays out for the reason recorded last time, re-checked here:
OpenRouter mints a slug for it, but reasoning effort is a parameter on the single `gpt-6-astra` id.

**Agent CLIs at their newest**, ahead of the 24h `minimumReleaseAge` window, as the Dockerfile's
standing note allows for those three pins alone: Claude Code 2.1.265 to 2.1.270 and Codex 0.153.4
to 0.154.0 (still above the 0.153.0 floor `gpt-6-astra` needs). Pi holds at 0.85.1, already newest.
The two Pi extensions do NOT take that exemption and hold at 2.9.0: 2.10.0 published three hours
before this change and has not aged past the window. Both harness images move to the newest
`node:26-trixie-slim` digest that has (node 26.8.2), and the executor image tag rolls to 1.158.0
with the deploy image at 0.6.8.

**Dependency refresh**: direct ranges plus a lockfile re-resolution, 31 resolved names moved, no
package name dropped. `pg-boss` 12.31.0 brings `rrule-temporal` and `temporal-spec` in as new
transitive deps, the only additions. A `pnpm dedupe` follows the bump because the partial
re-resolution left `@types/node` resolved at two patch versions. Four holds are unchanged and were
re-verified at HEAD rather than assumed: `vitest` at 4.1.11 and `wrangler` at 4.124.0
(`@cloudflare/vitest-pool-workers` 0.22.0 is still newest, peers `vitest: ^4.1.0` and pins that
wrangler exactly), `@cloudflare/workers-types` at 5.20260815.1 (the resolved workerd's date, which
that pool pins), and frontend TypeScript at 6.0.3 (vue-tsc 3.3.11 reaches for
`typescript/lib/tsc`, absent from TS 7's exports map). pnpm moves 11.24.0 to 11.26.0, staying on
its major. WireMock holds at 3.13.1, still its newest non-prerelease. Actions: `setup-java` v6.0.0
to v6.0.1 and `zizmor-action` v0.6.3 to v0.6.4; every other pinned action is already newest.
