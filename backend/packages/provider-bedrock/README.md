# @cat-factory/provider-bedrock

Opt-in **AWS Bedrock** model resolver for cat-factory's AI provisioning facade — lets a
deployment serve LLMs through Amazon Bedrock alongside (or instead of) the built-in direct
vendors.

## Why this is its own package

Bedrock support pulls in the AWS Bedrock SDK (`@ai-sdk/amazon-bedrock` + `ai`), which is heavy
and irrelevant to any deployment that doesn't use Bedrock. Keeping it in a separate opt-in
package means the core packages and the Cloudflare Worker base registry stay free of the SDK —
only a facade that actually wires Bedrock pays for it. It contributes a single provider
(`bedrock`) to a `CompositeModelProvider` through the neutral `ModelResolver` / `ProviderRegistry`
seam from `@cat-factory/agents`; no model-resolution logic is duplicated.

## Enabling it

The package exports two helpers:

- `bedrockResolver(opts)` → a `ModelResolver` for the `bedrock` provider.
- `bedrockRegistry(opts)` → a `ProviderRegistry` (`{ bedrock: resolver }`) ready to mix in.

### Node / local facade — via env

The Node facade wires Bedrock automatically **when `BEDROCK_REGION` is set** (see
`createNodeModelProviderResolver` in `backend/runtimes/node/src/modelProvider.ts`); it appends
`bedrockRegistry(...)` to the composite's extra registries:

```ts
if (env.BEDROCK_REGION) {
  extraRegistries.push(
    bedrockRegistry({
      region: env.BEDROCK_REGION,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
      // BEDROCK_MODELS="anthropic.claude-…,meta.llama3-…" → the allow-list below
      supportedModels: env.BEDROCK_MODELS?.split(',').map((m) => m.trim()).filter(Boolean),
    }),
  )
}
```

So a Node/local deployment opts in purely with env: `BEDROCK_REGION` (required to enable),
optional `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` (omit to use the
ambient AWS credential chain — instance role, `~/.aws`, etc.), and optional `BEDROCK_MODELS`
(comma-separated allow-list).

### Cloudflare Worker facade — via `registerModelRegistry`

The Worker's base registry ships without the SDK; a deployment mixes Bedrock in at startup
through the installation-level model-provider extension point (see
`backend/runtimes/cloudflare/src/infrastructure/ai/registries.ts`):

```ts
import { registerModelRegistry } from '@cat-factory/worker'
import { bedrockRegistry } from '@cat-factory/provider-bedrock'

registerModelRegistry((env) => bedrockRegistry({ region: env.BEDROCK_REGION }))
```

Registration is process-wide and read by every `buildContainer(env)` call, so the provider
reaches all paths — HTTP requests, the durable Workflow driver, and the cron sweeper — not just
one entry point. The factory receives the runtime `env`, so credentials/region come from the
deployment's configuration.

## How it resolves a model

The resolver forwards `ref.model` to the Bedrock provider (`createAmazonBedrock(...)`). A model is
addressed by its Bedrock model id (e.g. `anthropic.claude-3-5-sonnet-20240620-v1:0`). When
`supportedModels` is set, resolving anything outside the allow-list throws
`Unsupported Bedrock model: <id>` **up front**, so a misconfigured model fails fast with a clear
message instead of a deep AWS SDK error. Omit `supportedModels` to forward any model id.

## Config (`BedrockResolverOptions`)

| Option            | Purpose                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `region`          | AWS region, e.g. `us-east-1`.                                                         |
| `accessKeyId`     | Explicit AWS access key; omit to use the default AWS credential chain.               |
| `secretAccessKey` | Explicit AWS secret key.                                                             |
| `sessionToken`    | Explicit AWS session token (temporary credentials).                                  |
| `baseURL`         | Override the Bedrock base URL (e.g. a VPC endpoint).                                  |
| `supportedModels` | Allow-list of Bedrock model ids; resolving anything outside it throws. Omit to allow any. |

## Related

Part of cat-factory's opt-in **AWS stack** alongside [`@cat-factory/provider-s3`](../provider-s3)
(blob storage) and [`@cat-factory/eks`](../eks) (runner + environment backends). Each is
independent and registers into its own seam — mix in only what you use.
