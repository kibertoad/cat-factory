# `@cat-factory/mcp-server`

A [Model Context Protocol](https://modelcontextprotocol.io) server over the cat-factory **public
API** (`/api/v1`). It lets an MCP host — Claude Desktop, an IDE, an agent framework — plan work on a
workspace's board, start and watch runs, answer parked decisions, and read a run's telemetry.

It is a **facade**, not a client. Every tool is one call on
[`@cat-factory/sdk`](../typescript), and the tool table is generated from the same
[`docs/openapi.json`](../../docs/openapi.json) the four SDK clients are generated from.

## Run it

```jsonc
// An MCP host's server config
{
  "mcpServers": {
    "cat-factory": {
      "command": "npx",
      "args": ["-y", "@cat-factory/mcp-server"],
      "env": {
        "CAT_FACTORY_BASE_URL": "https://cat-factory.example.com",
        "CAT_FACTORY_API_KEY": "cf_live_...",
      },
    },
  },
}
```

Mint the key from the deployment (`backend/docs/public-api.md` §Setup) and give it the **narrowest
scope that does the job**: `read ⊂ write ⊂ decide ⊂ admin`. Every tool is scoped to the key's
workspace, and the key is what actually decides what a model can do here.

| Variable                           | Meaning                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL`             | The deployment's origin. Required.                              |
| `CAT_FACTORY_API_KEY`              | A public-API key. Required.                                     |
| `CAT_FACTORY_MCP_GROUPS`           | Comma-separated resource groups to expose. Unset ⇒ all of them. |
| `CAT_FACTORY_MCP_READ_ONLY`        | `true` ⇒ expose only the tools that change nothing.             |
| `CAT_FACTORY_MCP_MAX_RESULT_CHARS` | Ceiling on one tool result. Default 100,000.                    |
| `CAT_FACTORY_MCP_TIMEOUT_MS`       | Per-request deadline passed to the SDK. `0` disables it.        |

Missing credentials, an unknown group name and a non-numeric ceiling all **fail at startup**. A
server that comes up and then fails every call is reported by the host as connected, and the model
spends turns discovering otherwise.

To mount it on your own transport instead of stdio:

```ts
import { createCatFactoryMcpServer } from '@cat-factory/mcp-server'

const { server, tools } = createCatFactoryMcpServer({ baseUrl, apiKey })
await server.connect(myTransport)
```

## What "thin" means here

The facade decides three things: which tools to list, how to render one result, and how to render
one failure. Everything else — auth, retries, error classes, pagination, encoding, deadlines — is
the SDK's, so a tool behaves exactly like the same call made from code. A second implementation of
those rules would be a second place to get them subtly wrong.

Concretely:

- **The tool table is generated** (`src/tools.generated.ts`, by `pnpm gen:sdk`), so an endpoint
  added to `/api/v1` becomes a tool without anyone deciding twice, and `pnpm check:sdk` fails CI on
  drift. Never edit it by hand.
- **The input schema is the spec's own.** A tool's `body` schema is rendered from the same
  contract the deployment validates against, so a tool cannot describe a request shape the server
  would reject. An OPEN vocabulary (a closed set plus a documented escape hatch, like `taskType`)
  is never narrowed to an `enum`, because that would refuse a value the server accepts.
- **Argument validation stops at the door.** Required path ids are checked so a request can be
  built at all; the body goes to the deployment, whose 422 names the field and is far more useful
  to a model than anything this layer could say.
- **A failure is tool content, not a protocol error.** A protocol error means the SERVER
  misbehaved and hosts do not show it to the model. A 422 with `code`, `details.reason` and the
  per-field `issues` is the most actionable thing this facade ever returns, so it is passed
  through verbatim rather than re-worded.

## The tool surface

36 tools across eight groups, named `<group>_<method>` to match the SDK call (`client.tasks.create()`
⇄ `tasks_create`):

| Group             | What it covers                                                            |
| ----------------- | ------------------------------------------------------------------------- |
| `jobs_*`          | Headless runs of a public inline pipeline against a brief.                |
| `services_*`      | The board's service frames.                                               |
| `tasks_*`         | A task's whole lifecycle: create, edit, start, stop, retry, read its run. |
| `pipelines_*`     | Which pipelines a task can be started with.                               |
| `notifications_*` | The human-actionable inbox, including the merge tail.                     |
| `usage_*`         | The billing period's metered budget position.                             |
| `decisions_*`     | A parked run's human decisions.                                           |
| `debug_*`         | A run's recorded telemetry: LLM calls, agent context, infra logs.         |

**Two of the API's 38 operations are deliberately absent**, and the server says so in its
instructions rather than leaving a model to conclude the platform cannot do it:
`GET /api/v1/jobs/{id}/events` and `GET /api/v1/tasks/{taskId}/events` are SSE streams, and a tool
call returns one result over no streaming channel. Poll `jobs_get` / `tasks_get_run`, or consume the
streams through an SDK. Adding a bounded "wait for the run" tool would not fix this: a run parked on
a human decision waits **indefinitely** by design, so any such tool is a timeout dressed up as an
answer.

Generation FAILS on a new streaming operation nobody has classified, so the list above cannot go
quietly stale.

## Things a caller should know

- **`readOnlyHint` is set from the HTTP method** and is what a host uses to decide what needs a
  human's confirmation. `destructiveHint` and `idempotentHint` are deliberately left unset rather
  than guessed: a `DELETE` here is both idempotent and destructive, and an unset hint gets a host's
  safe default where a wrong one gets its unsafe one.
- **Read-only mode is a convenience, not a boundary.** It removes tools from this server; the key
  still carries whatever scope it was minted with. Mint a `read`-scoped key for the boundary.
- **A large result is truncated with a note that says so**, names how much was dropped, and points
  at the `limit` / `cursor` / `offset` parameters that would have avoided it. The truncated tail is
  not valid JSON and the note says that first, because a model that starts reading at the top will
  otherwise summarise half a document as though it were whole.
- **Spending tools are called out in the server's instructions**: `tasks_start`, `tasks_retry`,
  `jobs_create` each begin a real agent run, and `notifications_act` can merge a pull request.

## Development

```sh
pnpm --filter @cat-factory/mcp-server build
pnpm --filter @cat-factory/mcp-server test:run
pnpm gen:sdk      # regenerate the tool table after a contracts change
pnpm check:sdk    # the CI drift guard
```

The end-to-end tests drive a **real** MCP client over an in-memory transport against a real SDK
client whose `fetch` is stubbed, so a tool that lists but cannot be called fails a test rather than
shipping.
