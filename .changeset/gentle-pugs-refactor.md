---
'@cat-factory/integrations': minor
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Give the five HKDF cipher-info tags their own exported constants beside the services that
own the sealed data, and import them in both facades instead of re-typing the literals.

These strings derive the keys that seal provider subscriptions, provider API keys, personal
subscriptions, local model endpoints and user secrets at rest, so a divergence between the
two facades produces credentials one seals and the other cannot open, with nothing failing
loudly. Four of their siblings were already imported constants; these five had been missed.
