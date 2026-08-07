# @cat-factory/gatekeeper-bindings

A policy-annotated operation table for the cat-factory **public API** (`/api/v1`), for building
credential-holding front-ends: services that hold the API key themselves and meter what their own
callers may do. The motivating consumer is a [Cloudflare OS](https://github.com/cloudflare/cloudflare-os)
Gatekeeper Worker (see the
[initiative tracker](https://github.com/kibertoad/cat-factory/blob/main/docs/initiatives/cloudflare-os-gatekeeper.md)),
but nothing here is Cloudflare-specific: any proxy, bot or governance layer that fronts a
cat-factory key can use it.

Like [`sdk/mcp`](https://github.com/kibertoad/cat-factory/tree/main/sdk/mcp), this is **not a
fifth client**: it is the same operations the four SDKs expose, projected as a table and
generated from the same OpenAPI spec, so it cannot drift from the surface it meters. The thunks
call [`@cat-factory/sdk`](https://www.npmjs.com/package/@cat-factory/sdk) and re-implement none
of its behaviour.

## What each binding carries

One `GatekeeperBinding` per `/api/v1` operation:

- `name` (`tasks_create`): the policy spelling, identical to the MCP facade's tool name.
- `minScope`: the key-scope floor the deployment enforces for the route (`read` / `write` /
  `decide` / `admin`), read off the spec's `x-min-scope`, which the server generates from the
  same contract field its controllers enforce. This is the STATIC floor: a run-starting
  operation can still be refused `pipeline_requires_decide_scope` at request time when the named
  pipeline can park on a human.
- `readOnly`, `consequence`: what a front-end needs to decide which calls get waved through,
  which get logged, and which need a human. `consequence` is present only where the stakes are
  real money or a merged pull request, exactly as in the MCP tool table.
- `result`: how `invoke`'s answer comes back (`value`, SSE `stream`, or `binary` bytes), so a
  JSON-relay front-end can route or withhold the non-value operations, stating which.
- `pathParams` / `queryParams` / `hasBody` and `invoke(client, args)`: enough to expose the
  whole surface dynamically without hand-writing a wrapper per operation. The argument
  convention is the MCP facade's (path params and query keys at the top level, body under
  `body`; unknown keys are dropped, never forwarded).

Hand-written beside the table: `scopeSatisfies(have, need)`, `bindingsWithinScope(scope)` and
`bindingByName(name)`, the ladder helpers a policy layer ranks keys with.

## Example

```ts
import { CatFactoryClient } from '@cat-factory/sdk'
import {
  bindingByName,
  bindingsWithinScope,
  scopeSatisfies,
} from '@cat-factory/gatekeeper-bindings'

const client = new CatFactoryClient({ baseUrl: process.env.BASE_URL!, apiKey: process.env.KEY! })

// Expose to this caller only what a `write` key can do, minus anything destructive.
const exposed = bindingsWithinScope('write').filter((b) => !b.consequence?.destructive)

// Forward a metered call.
const binding = bindingByName('tasks_create')!
if (!scopeSatisfies('write', binding.minScope)) throw new Error('caller tier too low')
const result = await binding.invoke(client, {
  serviceId: 'svc_123',
  body: { title: 'Fix the flaky login test', description: '...' },
})
```

The full API reference (keys, scopes, endpoint semantics) is
[`backend/docs/public-api.md`](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/public-api.md);
the client family and generation chain are described in
[`sdk/README.md`](https://github.com/kibertoad/cat-factory/blob/main/sdk/README.md).

`src/bindings.generated.ts` is GENERATED (`pnpm gen:sdk`); change the route contracts, never the
file.
