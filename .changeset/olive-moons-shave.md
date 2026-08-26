---
'@cat-factory/kernel': patch
'@cat-factory/spend': patch
---

Add Qwen3.8 Max to the model catalog: Alibaba's flagship 2.4T-param multimodal MoE with a 1M
context, reachable direct on a DashScope key or through OpenRouter, with both routes priced in
the built-in spend table. No Cloudflare flavour is declared, because Workers AI serves the
open-weights Qwen3.8-27B rather than Max.
