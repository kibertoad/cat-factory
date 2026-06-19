---
'@cat-factory/provider-bedrock': minor
'@cat-factory/agents': minor
'@cat-factory/worker': minor
---

Introduce a generic, extensible AI provisioning facade so model resolution is no
longer hardwired to the Cloudflare Worker.

`@cat-factory/agents` now exposes `CompositeModelProvider` — a `ModelProvider`
composed from one or more mixable `ProviderRegistry` maps — plus the base,
runtime-neutral resolvers (`openAiResolver`, `anthropicResolver`,
`openAiCompatibleResolver`, `cloudflareRestResolver`, `baseProviderRegistry`) and
the shared OpenAI-compatible endpoint constants. Direct vendor usage works on any
runtime; `cloudflareRestResolver` adds a non-binding path to Cloudflare-hosted
models (Workers AI REST / AI Gateway) for non-Worker deployments.

AWS Bedrock support ships as a separate opt-in package,
`@cat-factory/provider-bedrock` (`bedrockResolver` / `bedrockRegistry`), so the
AWS SDK is pulled in only by deployments that use it. It throws a clear
`Unsupported Bedrock model` for any model id outside its configured allow-list.

`@cat-factory/worker`'s `CloudflareModelProvider` is now a thin composition of the
shared facade (behaviour unchanged: same providers, same "not configured" errors),
and a new installation extension point — `registerModelRegistry` — lets a
deployment mix extra provider registries (e.g. Bedrock) into every container build,
including the durable Workflow and cron-sweeper paths.
