# @cat-factory/gatekeeper-bindings

## What it is

A policy-annotated table of every cat-factory **public API** (`/api/v1`) operation, plus the
scope-ladder helpers a policy layer ranks keys and classifies calls with. Like
[`sdk/mcp`](https://github.com/kibertoad/cat-factory/tree/main/sdk/mcp), this is **not a fifth
client**: it is the same operations the four SDKs expose, projected as a table and generated from
the same OpenAPI spec (`pnpm gen:sdk`), so it cannot drift from the surface it meters. The thunks
call [`@cat-factory/sdk`](https://www.npmjs.com/package/@cat-factory/sdk) and re-implement none of
its behaviour.

It is the data half of the cat-factory **Gatekeeper** family, three pieces taken two different
ways:

| Piece                                                                                            | What it is                                                                                                  | How you take it                         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `@cat-factory/gatekeeper-bindings` (this package)                                                | the generated operation table and the scope helpers                                                         | install, to build your own policy layer |
| [`@cat-factory/gatekeeper-worker`](https://www.npmjs.com/package/@cat-factory/gatekeeper-worker) | the full Gatekeeper Worker machinery: Cap'n Web capability surface, key broker, webhook receiver, approvals | install, and write only a policy        |
| [`deploy/gatekeeper`](https://github.com/kibertoad/cat-factory/tree/main/deploy/gatekeeper)      | the deployment template: a policy file, wrangler bindings, three lines of wiring                            | copy, and edit `src/policy.config.ts`   |

## Purpose and goal

For building **credential-holding front-ends**: services that hold the cat-factory API key
themselves and meter what their own callers may do. The motivating consumer is a
[Cloudflare OS](https://github.com/cloudflare/cloudflare-os) Gatekeeper Worker (design record: the
[design record](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0052-cloudflare-os-gatekeeper.md)),
but nothing here is Cloudflare-specific: any proxy, bot or governance layer that fronts a
cat-factory key can use it.

The goal is that such a layer enforces policy against the operations the deployment actually
serves, at the scope floors it actually enforces, never against a hand-curated list that drifts.
The floors come from the spec's `x-min-scope`, which the server generates from the same contract
field its controllers enforce, so the declared scope and the enforced scope are one value.

## What each binding carries

One `GatekeeperBinding` per `/api/v1` operation:

- `name` (`tasks_create`): the policy spelling, identical to the MCP facade's tool name.
- `minScope`: the key-scope floor the deployment enforces for the route (`read` / `write` /
  `decide` / `admin`), read off the spec's `x-min-scope`. This is the STATIC floor: a run-starting
  operation can still be refused `pipeline_requires_decide_scope` at request time when the named
  pipeline can park on a human.
- `readOnly`, `consequence`: what a front-end needs to decide which calls get waved through,
  which get logged, and which need a human. `consequence` is present only where the stakes are
  real money or a merged pull request, exactly as in the MCP tool table, so read it through
  `resolveConsequence(binding)` rather than directly: an unannotated mutation is cautiously
  destructive, and `binding.consequence?.destructive` would answer `false` for it.
- `result`: how `invoke`'s answer comes back (`value`, SSE `stream`, or `binary` bytes), so a
  JSON-relay front-end can route or withhold the non-value operations, stating which.
- `pathParams` / `queryParams` / `hasBody` and `invoke(client, args)`: enough to expose the
  whole surface dynamically without hand-writing a wrapper per operation. The argument
  convention is the MCP facade's (path params and query keys at the top level, body under
  `body`; unknown keys are dropped, never forwarded).

## The helpers

Hand-written beside the table (`src/index.ts`), because every consumer needs them and deriving
them independently is how one gets them backwards:

- `scopeSatisfies(have, need)`: whether a key of scope `have` clears a floor of `need`. The
  ladder is inclusive: every rung can do everything below it.
- `bindingsWithinScope(scope)`: every operation a key of that scope can call.
- `bindingByName(name)`: one operation by its policy spelling; `undefined` for a name the surface
  does not have, so a misspelled or retired name is a condition the caller reports rather than a
  thrown surprise.
- `resolveConsequence(binding)`: the consequence annotation with the cautious default applied (an
  unannotated mutation counts as destructive and non-idempotent).
- `PUBLIC_API_SCOPE_LADDER`: the scope ranking itself, emitted from the spec's
  `x-public-api-scopes`.
- `renderSessionTypes(request)`: the `.d.ts` an object-capability session serves as its TypeScript
  types, composed from the generated `SESSION_METHOD_SIGNATURES` for exactly the operations a
  policy granted. Per-grant rather than shipped whole, because a file naming the full surface would
  promise methods the object does not have. It THROWS on a name it has no signature for: a silently
  dropped method reads to an agent exactly like an operation the deployment does not serve, and the
  two need opposite fixes.

The ladder helpers **throw on a scope they do not carry** rather than ranking it below `read`:
a deployment one release ahead of this package must read as version skew, never as a key with no
permissions.

## How to use it

```ts
import { CatFactoryClient } from '@cat-factory/sdk'
import {
  bindingByName,
  bindingsWithinScope,
  resolveConsequence,
  scopeSatisfies,
} from '@cat-factory/gatekeeper-bindings'

const client = new CatFactoryClient({ baseUrl: process.env.BASE_URL!, apiKey: process.env.KEY! })

// Expose to this caller only what a `write` key can do, minus anything destructive. Read the
// consequence through the helper: most mutations carry no annotation, and the unannotated ones
// are the cautious case, not the safe one.
const exposed = bindingsWithinScope('write').filter((b) => !resolveConsequence(b).destructive)

// Forward a metered call.
const binding = bindingByName('tasks_create')!
if (!scopeSatisfies('write', binding.minScope)) throw new Error('caller tier too low')
const result = await binding.invoke(client, {
  serviceId: 'svc_123',
  body: { title: 'Fix the flaky login test', description: '...' },
})
```

Two routes are deliberately absent from the table because they have no honest operation shape:
`GET /api/v1/openapi.json` (spec discovery) and `ALL /api/v1/mcp` (the hosted MCP endpoint). Both
gate at `read` on the server.

## What is generated

Two files, both by `pnpm gen:sdk` and both guarded against drift by `pnpm check:sdk`:

| File                             | What it carries                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/bindings.generated.ts`      | The operation table: scope floors, mutation and transport metadata, consequence hints, invoke thunks. |
| `src/session-types.generated.ts` | One TypeScript method signature per operation, for composing a granted session's `.d.ts`.             |

The signatures carry fully typed ARGUMENTS (path parameters, query keys with their requiredness, a
body where the operation takes one) and an `unknown` result. That is deliberate rather than a gap:
a session relays the deployment's own decoded JSON, and the authority for those shapes is the
OpenAPI document at `GET /api/v1/openapi.json`, which every deployment serves. Inlining the model
tree would put a second copy of it inside every consumer's bundle, free to disagree with the first.

## Configuration and customization

Nothing in this package is configured or customized: it is generated data plus pure helpers, and
the policy built on top of it belongs to the consumer (see `@cat-factory/gatekeeper-worker` for a
ready-made one). `src/bindings.generated.ts` is GENERATED (`pnpm gen:sdk`); change the route
contracts, never the file.

## References

- [`backend/docs/public-api.md`](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/public-api.md):
  the full API reference (keys, scopes, endpoint semantics).
- [`sdk/README.md`](https://github.com/kibertoad/cat-factory/blob/main/sdk/README.md): the client
  family and the generation chain this table rides.
- [`@cat-factory/gatekeeper-worker`](https://www.npmjs.com/package/@cat-factory/gatekeeper-worker):
  the Worker machinery that compiles deployment policy against this table.
- [ADR 0052](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0052-cloudflare-os-gatekeeper.md):
  the design record, the alternatives it was decided against, and the traps the build surfaced.
