---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

A deployment can now declare its capability-credential chain store-ONLY, and the operator surface
describes the chain that was actually composed instead of asserting a default beside it.

`capabilityCredentialEnvironmentFallback: false` on any facade (`start` / `startLocal` /
`createWorker`) composes the per-workspace sealed store with no environment resolver behind it. That
is the multi-tenant shape: with the fallback on, a workspace that has typed nothing silently
authenticates its runs as whoever set the deployment's variable and bills that vendor account, which
is the single-tenant answer the store exists to replace. The default is unchanged, because whether a
hosted deployment should ship store-only is a product call.

The chain is now composed once, at each facade's composition root, by `buildToolSecretChain`, which
returns the resolver together with what it consults. The credential checklist reads that rather than
hard-coding "the environment may still answer", so a blank row means the same thing on the surface
and in the dispatch path.

Compatibility break: `environmentFallback` on the capability-credentials view is optional rather than
always present, and absent is a real answer — a deployment that supplied its own `ToolSecretResolver`
replaced the chain, so whether it reads the environment is not knowable here, and both guesses fail
silently in opposite directions. The Worker's process-wide `registerToolSecretResolverFactory` is
replaced by `registerToolSecretPolicy({ createResolver?, environmentFallback? })`; a deployment using
the documented `createWorker` seam needs no change.
