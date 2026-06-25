---
"@cat-factory/app": patch
"@cat-factory/kernel": minor
"@cat-factory/spend": patch
---

Fix the OpenRouter key panel falsely reporting "connected" on a rejected key, and add Kimi K2.7 as a curated OpenRouter model.

- The OpenRouter setup panel (`OpenRouterCatalogPanel`) used to fire its "OpenRouter key connected" success toast — and flip the panel into the connected state — *before* probing OpenRouter, since the save endpoint stores keys without validating them. A wrong/expired key therefore showed a 401 "could not reach OpenRouter" toast **and** a "connected" status simultaneously. `connectKey` now probes OpenRouter with the freshly stored key first, only announces success when it's reachable, and rolls the key back on rejection so the form stays for a retry. (The Vendors & keys → Proxies screen shares the same store-only save codepath; it never showed the bug because it doesn't probe OpenRouter after saving.)
- `kimi-k2.7` now carries an `openrouter` flavour (`moonshotai/kimi-k2.7-code`, 256K context per OpenRouter's catalog), so it routes through the OpenRouter gateway out of the box once an OpenRouter key is connected. It's added to the OpenRouter panel's "Enable recommended" slugs and the spend price table (billed at Moonshot's upstream rates).
