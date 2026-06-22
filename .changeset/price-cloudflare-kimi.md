---
'@cat-factory/spend': patch
---

Price Cloudflare Workers AI Kimi models (`@cf/moonshotai/kimi-k2.6` and
`@cf/moonshotai/kimi-k2.7-code`) at Cloudflare's published Workers AI per-token
rate ($0.95 in / $4.00 out per 1M, USD→EUR ~0.92) instead of letting them fall
through to the near-free `workers-ai` neuron rate. Kimi K2.7 is the default coder,
so without explicit `workers-ai:@cf/moonshotai/...` entries every Cloudflare-Kimi
run metered at 0.1/0.1 EUR per million tokens and showed spend as ~0.00. Mirrors
the existing partner-model exception for `deepseek-v4-pro`.
