# @toad-contracts/hono

Hono adapter for [`@toad-contracts`](https://github.com/kibertoad/toad-contracts). Define an HTTP
contract once with `defineApiContract` and mount it as a fully typed, self-validating Hono route. The
method, path and request schemas are derived from the contract, and the handler's `c.req.valid(...)`
data and return type are inferred from it.

Unlike a generic Hono validator, this package rolls its own validator typed directly from the
contract surface, so there is no separate type provider to wire up. Validation runs against the
contract's Standard Schemas, so any Standard Schema library (valibot, zod, ...) works.

## Table of Contents

- [Requirements](#requirements)
- [Builders](#builders)
  - [`buildHonoRoute`](#buildhonoroute)
  - [`buildHonoRouteHandler`](#buildhonoroutehandler)
  - [Accessing the contract](#accessing-the-contract)
  - [Accessing the app's own context variables](#accessing-the-apps-own-context-variables)
  - [Validation errors](#validation-errors)
  - [Query parameters and arrays](#query-parameters-and-arrays)
  - [Adding middleware from contract metadata](#adding-middleware-from-contract-metadata)
- [Test helper](#test-helper)
  - [`requestByContract`](#requestbycontract)

## Requirements

`hono` is a peer dependency (`>=4`). This package is ESM-only.

## Builders

### `buildHonoRoute`

`buildHonoRoute(app, contract, handler)` registers a contract on a Hono app and returns the app for
chaining. The HTTP method and path come from the contract; one validator is wired per declared
request schema (path params, query, headers, body). The handler is typed from the contract:

- `c.req.valid('param' | 'query' | 'header' | 'json')` carry the parsed, transformed request data
  (the `'json'` target exists only for contracts with a request body).
- the return value is constrained to the contract's `responsesByStatusCode`, so `c.json(body, status)`
  is checked against the declared body and status.

Path-param schemas must be wrapped with `withObjectKeys` from `@toad-contracts/valibot` (or your
schema adapter's equivalent). Core needs the path-param field names to build the route path, and the
Standard Schema interface does not expose object keys; the adapter supplies that capability. Query,
header and body schemas need no wrapping.

```ts
import { buildHonoRoute } from '@toad-contracts/hono'
import { defineApiContract, ContractNoBody } from '@toad-contracts/core'
import { withObjectKeys } from '@toad-contracts/valibot'
import { object, string } from 'valibot'
import { Hono } from 'hono'

const app = new Hono()

// GET
buildHonoRoute(
  app,
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: withObjectKeys(object({ userId: string() })),
    requestQuerySchema: QUERY_SCHEMA,
    pathResolver: ({ userId }) => `/users/${userId}`,
    responsesByStatusCode: { 200: RESPONSE_BODY_SCHEMA },
  }),
  (c) => {
    const { userId } = c.req.valid('param')
    const query = c.req.valid('query')
    return c.json({ name: 'Frodo' }, 200)
  },
)

// POST
buildHonoRoute(
  app,
  defineApiContract({
    method: 'post',
    requestBodySchema: REQUEST_BODY_SCHEMA,
    pathResolver: () => '/users',
    responsesByStatusCode: { 201: RESPONSE_BODY_SCHEMA },
  }),
  (c) => {
    const body = c.req.valid('json')
    return c.json({ name: 'Sam' }, 201)
  },
)

// DELETE returning no body
buildHonoRoute(
  app,
  defineApiContract({
    method: 'delete',
    requestPathParamsSchema: withObjectKeys(object({ userId: string() })),
    pathResolver: ({ userId }) => `/users/${userId}`,
    responsesByStatusCode: { 204: ContractNoBody },
  }),
  (c) => c.body(null, 204),
)
```

The route path is derived from the contract via core's `mapApiContractToPath`, which reads the
path-param keys through the schema's adapter-supplied object-key surface and replaces each with a
`:placeholder`, so `(p) => /users/${p.userId}` becomes the Hono path `/users/:userId`.

### `buildHonoRouteHandler`

Define a handler separately from the route, typed from the contract, then pass it to `buildHonoRoute`:

```ts
import { buildHonoRoute, buildHonoRouteHandler } from '@toad-contracts/hono'

const handler = buildHonoRouteHandler(contract, (c) => {
  // c.req.valid(...) and the return type are typed from the contract
  return c.json({ name: 'Sam' }, 201)
})

buildHonoRoute(app, contract, handler)
```

### Accessing the contract

The contract is exposed on the context, so handlers and middleware can read it:

```ts
buildHonoRoute(app, contract, (c) => {
  const apiContract = c.get('apiContract')
  return c.json({ name: 'Frodo' }, 200)
})
```

### Accessing the app's own context variables

`buildHonoRoute` infers the app's `Env` from the app instance, so a handler on a typed app keeps its
own context variables typed alongside `apiContract`. Pass a `Hono<AppEnv>` and `c.get('container')`,
`c.get('user')`, and similar resolve from `AppEnv['Variables']` with no extra annotation:

```ts
type AppEnv = { Variables: { container: ServerContainer; user?: SessionPayload } }

const app = new Hono<AppEnv>()

buildHonoRoute(app, contract, (c) => {
  const container = c.get('container') // typed as ServerContainer
  const user = c.get('user') // typed as SessionPayload | undefined
  const apiContract = c.get('apiContract') // still typed from the contract
  return c.json({ name: 'Frodo' }, 200)
})
```

For a handler defined away from its app (no instance to infer the env from), bind the env once with
`honoContractRoutes<AppEnv>()`. It returns `buildHonoRoute` and `buildHonoRouteHandler` bound to the
env, plus `requestByContract` re-exported unchanged for convenience:

```ts
import { honoContractRoutes } from '@toad-contracts/hono'

const { buildHonoRoute, buildHonoRouteHandler } = honoContractRoutes<AppEnv>()

const handler = buildHonoRouteHandler(contract, (c) => {
  const container = c.get('container') // typed as ServerContainer
  return c.json({ name: 'Sam' }, 201)
})

buildHonoRoute(app, contract, handler)
```

Hono's `Context` is invariant in its env, so a standalone handler typed with the bare
`buildHonoRouteHandler` (no env) is not assignable to a route on an app with its own env: that is a
type error by design, catching env mismatches. Use the factory's `buildHonoRouteHandler` for such
handlers. Inline handlers passed straight to the free `buildHonoRoute` need none of this.

### Validation errors

When a request fails contract validation, the validator throws a `SchemaValidationError`
(from `@toad-contracts/core`) by default. Map it in the app's `onError`:

```ts
import { SchemaValidationError } from '@toad-contracts/core'

app.onError((error, c) => {
  if (error instanceof SchemaValidationError) {
    return c.json({ issues: error.issues }, 400)
  }
  throw error
})
```

Or handle it per route with `onValidationError`:

```ts
buildHonoRoute(app, contract, handler, {
  onValidationError: (error, c) => c.json({ issues: error.issues }, 400),
})
```

A request whose body is empty or not valid JSON (when the contract declares a request body) is
treated the same way: it surfaces as a `SchemaValidationError` rather than escaping as an unhandled
500, so the same `onError` / `onValidationError` handling applies.

### Query parameters and arrays

Repeated query keys are validated as arrays (`?id=1&id=2` → `["1", "2"]`), and a single occurrence
is validated as a scalar (`?q=find` → `"find"`), mirroring Hono's own validator so both scalar and
array query schemas work.

Two array cases cannot be represented in a query string, by HTTP and Hono convention rather than a
limitation of this adapter (a browser, `fetch`, or `requestByContract` all hit the same boundary):

- a single-element array round-trips as a scalar (`?tags=x` is read back as `"x"`, not `["x"]`);
- an empty array cannot be sent at all (the key is simply absent).

If a field must accept one value, model it to accept the scalar (or absent) form, for example
`optional(union([array(string()), string()]))`. In tests that exercise an array query param via
`requestByContract`, send two or more values.

### Adding middleware from contract metadata

`buildHonoRoute` accepts an optional `contractMetadataToRouteMapper` that maps the contract metadata
to extra middleware appended after the validators:

```ts
buildHonoRoute(app, contract, handler, {
  contractMetadataToRouteMapper: (metadata) => ({
    middleware: [authMiddlewareFor(metadata)],
  }),
})
```

## Test helper

### `requestByContract`

`requestByContract(app, contract, params)` dispatches a request against a Hono app from a contract
using Hono's native `app.request()` (no server needed). Request inputs are validated and transformed
through the contract's request schemas before sending. Params are typed from the contract: each field
is required only when the contract declares the matching request schema.

```ts
import { requestByContract } from '@toad-contracts/hono'

const response = await requestByContract(app, createUserContract, {
  pathParams: { userId: '1' },
  body: { id: '2' },
  headers: async () => ({ authorization: 'token' }), // plain object or (a)sync function
})

expect(response.status).toBe(201)
```

`pathPrefix` is always optional; when provided it is prepended to the path resolved from the contract
(e.g. to hit a route mounted under a Hono base path).
