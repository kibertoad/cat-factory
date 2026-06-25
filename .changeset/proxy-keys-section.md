---
'@cat-factory/app': minor
---

Split provider credentials into horizontal tabs and give proxies their own section.
OpenRouter and LiteLLM are intermediaries, not direct vendors, so they no longer sit
under "Direct provider API keys" — they move to a dedicated "Proxies" tab. The vendor
credentials modal now uses horizontal tabs (Workspace pool / Direct providers / Proxies /
Personal subscriptions) instead of one long vertical scroll, and account settings expose
both direct and proxy account keys.
