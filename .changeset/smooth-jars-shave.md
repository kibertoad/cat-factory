---
'@cat-factory/integrations': patch
---

Fix every Kubernetes apiserver call that carries a custom CA or "skip TLS verification": the
undici `Agent` holding the TLS options was handed to Node's global `fetch`, whose request handler
comes from Node's own bundled undici, so one undici validated the other's handler and the request
died before a socket was opened as `fetch failed: invalid onRequestStart method
(UND_ERR_INVALID_ARG)`. The dispatcher and the `fetch` that uses it now come from one undici
instance. A k3s apiserver serves a self-signed certificate, so this was every k3s connection.

`undici` moves from `devDependencies` to `dependencies`, where the runtime import that path
performs has always belonged. Declared as dev-only it resolved in every test lane and in no
production image (`pnpm install --prod` prunes it), so the same calls would have kept failing
once deployed, and a load failure now reports the load error itself instead of claiming the
runtime is not Node.
