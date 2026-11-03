---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/conformance': patch
---

A registered task source can now answer a vendor's endpoint-verification request, such as Slack's `url_verification` challenge. `TaskSourceWebhookAdapter` has an optional `handshake(delivery)` member. The task webhook receiver calls it only after the signature is verified, and when it returns a response the receiver sends that body with a 200 instead of parsing and acking the delivery. Adapters without the member behave as before.
