# `@cat-factory/sdk`

TypeScript / JavaScript client for the cat-factory **public API** (`/api/v1`).

```sh
npm install @cat-factory/sdk
```

Node 20+. No dependencies: the transport is `fetch`.

```ts
import { CatFactoryClient, CatFactoryNotFoundError } from '@cat-factory/sdk'

const client = new CatFactoryClient({
  baseUrl: 'https://cat-factory.example.com',
  apiKey: process.env.CAT_FACTORY_API_KEY!,
})

const { services } = await client.services.list()
const task = await client.tasks.create(services[0].serviceId, {
  title: 'Add a health check endpoint',
  taskType: 'feature',
})
await client.tasks.start(task.taskId, {})
```

## Resource clients

`jobs`, `services`, `tasks`, `pipelines`, `notifications`, `usage`, `decisions`, `debug`:
one per tag of the published OpenAPI surface. Every call is scoped to the key's workspace.

## Watching a run

```ts
const stream = await client.tasks.stream(task.taskId)
try {
  for await (const event of stream) {
    if (event.event === 'decision') {
      // The run PARKED on a human decision and waits indefinitely. Answer it through
      // `client.decisions` (needs a `decide`-scope key) or free it with `tasks.stop`.
      const { decisions } = await client.decisions.list(runId)
    }
    if (event.event === 'done' || event.event === 'error') break
    // `timeout` means the deployment's connection cap was reached, NOT that the run finished.
  }
} finally {
  await stream.close()
}
```

## Paging

Every bounded list has an auto-paging companion that follows `nextCursor` for you:

```ts
for await (const task of client.tasks.listByServiceAll(serviceId)) {
  console.log(task.taskId)
}
```

## Errors

The exception CLASS comes from the HTTP status; `code` carries the specific cause and is a plain
string, because this surface adds new codes without a major version.

```ts
try {
  await client.tasks.get(taskId)
} catch (error) {
  if (error instanceof CatFactoryNotFoundError) return null
  if (error instanceof CatFactoryForbiddenError && error.code === 'insufficient_scope') {
    throw new Error('this key needs a higher scope')
  }
  throw error
}
```

Classes: `CatFactoryValidationError` (400/422), `…Unauthorized` (401), `…Forbidden` (403),
`…NotFound` (404), `…Conflict` (409), `…CredentialRequired` (428), `…RateLimited` (429),
`…ServerError` (5xx), plus `…ConnectionError`, `…TimeoutError` and `…DecodeError`. All extend
`CatFactoryError`. Every API error carries `status`, `code`, `details`, `issues` and the
`requestId` to quote when reporting a fault.

## Options

```ts
new CatFactoryClient({
  baseUrl,
  apiKey,
  timeoutMs: 30_000, // 0 disables
  maxRetries: 2, // idempotent requests only - a POST is never auto-retried
  headers: {},
  userAgent: 'my-integration/1.2.3',
  fetch: myFetch, // a proxy agent, or a test double
})
```

## Local development and mocks

The base URL takes any origin (`http://localhost:8787`, a fixture server, a mock) and no scheme
validation is applied. Each client also accepts a custom transport, so you can intercept in-process
instead. See [the SDK guide](../README.md#pointing-an-sdk-at-localhost-or-a-mock).

## Notes

- `src/*.generated.ts` are generated from `docs/openapi.json`; see [`../README.md`](../README.md).
- The sources are **erasable-only** TypeScript (no enums, namespaces or parameter properties), so
  they run under Node's type stripping and `erasableSyntaxOnly` builds.
- API reference: [`backend/docs/public-api.md`](../../backend/docs/public-api.md).
