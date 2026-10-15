---
'@cat-factory/contracts': minor
'@cat-factory/integrations': patch
'@cat-factory/local-server': minor
'@cat-factory/sdk': patch
'@cat-factory/mcp-server': patch
'@cat-factory/gatekeeper-bindings': patch
---

Directory and notification webhook endpoints may be `http://` where the deployment allows it.
The request schemas refused every `http://` URL before the URL policy ran, so
`NOTIFICATION_WEBHOOK_ALLOW_HTTP_URLS` and `NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` could never
admit one. The schemas now accept `http://` and `https://`, and the policy decides: hosted
deployments stay https-only with no private hosts, as before.

Local mode turns that policy on by default for `localhost`, `127.0.0.1`,
`host.docker.internal` and `*.localhost`, the way it already does for environment URLs. A
receiver on the same laptop (a local sainte-beuve following the directory) can register its
push endpoint with no tunnel.

The SDK clients are regenerated against OpenAPI 1.85.0.
