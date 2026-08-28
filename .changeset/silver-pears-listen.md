---
'@cat-factory/kernel': patch
'@cat-factory/spend': patch
---

Add GLM-5.3 Flash to the model catalog: Z.ai's cheap natively multimodal GLM-5 (320B total, 18B
active), served on Workers AI, through OpenRouter, and on a GLM (Z.ai) coding-plan subscription,
with all three routes priced in the built-in spend table at Z.ai's list rate rather than its
launch discount. Image input is declared on the two routes whose providers document it and left
undeclared on the coding-plan route, which reaches Z.ai's Anthropic-compatible endpoint.
