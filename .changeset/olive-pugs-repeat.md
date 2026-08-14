---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/spend': patch
'@cat-factory/worker': patch
---

Add GLM-5.3, Gemini 3.7 Flash and Grok 4.6 to the model catalog, and re-baseline the spend
price table against what the providers currently charge.

New catalog entries: `glm-5.3` (subscription-only, GLM Coding Plan), `gemini-3.7-flash`
(OpenRouter) and `grok` (Grok 4.6, direct via a new `xai` provider or OpenRouter). GLM-4.7
Flash gains a Bedrock flavour (`zai.glm-4.7-flash`).

`xai` is a new direct provider: `XAI_API_KEY` joins the poolable key providers and the
reserved-env-key list, `XAI_BASE_URL` overrides the endpoint, and `grok` joins the model
family vocabulary the account model policy allows or blocks. A policy in `allowlist` mode
does not admit the new family until an admin adds it, which is the intended default.

Price corrections, several of which were metering runs BELOW their real cost: DeepSeek's V4
pair moves to the peak rates its 2026-08-16 peak/off-peak switch introduces, the OpenRouter
`deepseek/deepseek-v4-pro` alias nearly triples, and Cloudflare's now-published cached-input
rates for GLM-5.2 and the Kimi pair replace a derived floor that was ~1.9x too low. GLM-5.2
and Gemini 3.6 Flash on OpenRouter were overpriced and come down. Z.ai subscription refs
(`zai:*`) were falling through to the generic default price and now carry Z.ai's list rate.
