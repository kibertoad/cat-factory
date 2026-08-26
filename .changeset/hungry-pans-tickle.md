---
'@cat-factory/spend': patch
---

Re-validate the built-in spend pricing table against vendor list prices. Corrects several
entries that under-metered runs (both GPT-5.6 mid tiers, Moonshot's own Kimi K2.6 rate,
DeepSeek V4 Pro on Workers AI, GLM-5.2 through OpenRouter), drops Claude Sonnet 5 to the
$2/$10 Anthropic has since made permanent, and names the cache-read tiers vendors have
begun publishing instead of deriving them.
