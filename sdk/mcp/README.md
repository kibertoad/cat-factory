# `@cat-factory/mcp-server`

A [Model Context Protocol](https://modelcontextprotocol.io) server over the cat-factory **public
API** (`/api/v1`). It lets an MCP host — Claude Desktop, an IDE, an agent framework — plan work on a
workspace's board, start and watch runs, answer parked decisions, and read a run's telemetry.

> **Using it is documented on the website**:
> [MCP Server](https://www.catfactory.ai/extend/mcp-server.html) owns the two access paths, the
> configuration table, the tool surface and the worked flow, for readers who never clone this repo.
> This README ships in the published tarball, so it stays self-contained rather than becoming a
> pointer; keep the two in step when the tool surface or the filters change.

It is a **facade**, not a client. Every tool is one call on
[`@cat-factory/sdk`](https://github.com/kibertoad/cat-factory/tree/main/sdk/typescript), and the tool table is generated from the same
[`docs/openapi.json`](https://github.com/kibertoad/cat-factory/blob/main/docs/openapi.json) the four SDK clients are generated from.

## Do you need this package?

There are two ways to reach a cat-factory deployment over MCP, and they serve the same server.

- **Hosted**, `POST /api/v1/mcp` on the deployment itself. Nothing to install: give the host a URL
  and a key. This is the one to reach for if the host speaks HTTP MCP. See
  [`backend/docs/public-api.md`](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/public-api.md#from-an-mcp-host).
- **This package**, over stdio. It needs no backend deployment of your own, it is the only path for
  a host that cannot speak HTTP MCP, and it is the only one with per-host tool filters.

A deployment mounts the hosted endpoint from this package too (`handleMcpHttpRequest`, below), so
the tool table, the instructions and the result rendering are the same bytes on both paths.

## Run it

With Claude Code, in one line:

```sh
claude mcp add cat-factory \
  --env CAT_FACTORY_BASE_URL=https://cat-factory.example.com \
  --env CAT_FACTORY_API_KEY_FILE=$HOME/.config/cat-factory/api-key \
  -- npx -y @cat-factory/mcp-server
```

Or in any host's own config format:

```jsonc
// An MCP host's server config
{
  "mcpServers": {
    "cat-factory": {
      "command": "npx",
      "args": ["-y", "@cat-factory/mcp-server"],
      "env": {
        "CAT_FACTORY_BASE_URL": "https://cat-factory.example.com",
        "CAT_FACTORY_API_KEY_FILE": "/home/you/.config/cat-factory/api-key",
      },
    },
  },
}
```

Mint the key from the deployment (`backend/docs/public-api.md` §Setup) and give it the **narrowest
scope that does the job**: `read ⊂ write ⊂ decide ⊂ admin`. Every tool is scoped to the key's
workspace, and the key is what actually decides what a model can do here.

| Variable                           | Meaning                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL`             | The deployment's origin. Required.                                         |
| `CAT_FACTORY_API_KEY`              | A public-API key. Required, unless the file below is given.                |
| `CAT_FACTORY_API_KEY_FILE`         | A file holding the key instead. Either one, never both.                    |
| `CAT_FACTORY_MCP_GROUPS`           | Comma-separated resource groups to expose. Unset ⇒ all of them.            |
| `CAT_FACTORY_MCP_TOOLS`            | Comma-separated tool names to expose. Unset ⇒ all the other filters leave. |
| `CAT_FACTORY_MCP_EXCLUDE_TOOLS`    | Comma-separated tool names to withhold, applied after every other filter.  |
| `CAT_FACTORY_MCP_READ_ONLY`        | `true` ⇒ expose only the tools that change nothing.                        |
| `CAT_FACTORY_MCP_MAX_RESULT_CHARS` | Ceiling on one tool result. Default 100,000.                               |
| `CAT_FACTORY_MCP_TIMEOUT_MS`       | Per-request deadline passed to the SDK. `0` disables it.                   |
| `CAT_FACTORY_MCP_MAX_RETRIES`      | Retries for a retriable failure, passed to the SDK.                        |

Missing credentials, an unknown group or tool name, a filter combination that would expose nothing,
and a non-numeric ceiling all **fail at startup**. A server that comes up and then fails every call
is reported by the host as connected, and the model spends turns discovering otherwise.

### Keep the key out of the host's config

`CAT_FACTORY_API_KEY_FILE` names a file to read the key from. A stdio server's environment IS the
host's config file, so the inline variable means a long-lived credential in plaintext in a home
directory, readable by everything that can read that file and present in every backup and every
screen share of it. A path is not a secret, so pointing at one lets the key live somewhere locked
down (`chmod 600`, a mounted secret, a secrets-manager sidecar's drop).

Setting **both** is refused rather than resolved by precedence: two live sources for one credential
means a rotation can land on the half nobody reads, and the deployment goes on working with the old
key right up until it is revoked.

### Choosing what a model can reach

Three filters, narrowest last, all of them a convenience rather than a boundary (the key's scope is
the boundary):

- `CAT_FACTORY_MCP_GROUPS` is the coarse unit an operator thinks in: "no debug tools on this one".
- `CAT_FACTORY_MCP_TOOLS` exposes an explicitly chosen set. Precise, but it has to be re-edited
  whenever `/api/v1` grows, and a forgotten edit silently withholds the new capability.
- `CAT_FACTORY_MCP_EXCLUDE_TOOLS` withholds named tools and keeps admitting everything else,
  including tools added later. This is the one to reach for to keep ONE capability away from a model:
  `CAT_FACTORY_MCP_EXCLUDE_TOOLS=notifications_act` keeps the PR-merging tool away without costing
  the inbox it belongs to.

Whatever is switched off, the server **says so in its instructions**, naming the withheld tools and
stating that the deployment still supports them. An unexplained absence reads to a model as a
platform that cannot do the thing, which it then reports to its user, or works around.

## A worked flow

Create a task, run it, watch it, answer the park. This is the shape of nearly every session here:

1. **`services_list`**: the board's service frames. A task is created under one, and the `serviceId`
   comes from here rather than being guessable.
2. **`pipelines_list`**: which pipelines a task can be started with, and which are headless-startable.
3. **`tasks_create`** (`serviceId`, `body.title`, `body.description`, `body.taskType`) returns the
   `taskId`. Nothing runs yet; this is a board card.
4. **`tasks_start`** (`taskId`) **spends**: it begins a real agent run against a real repository, and
   returns the `runId`. Confirm with the person first; the tool is annotated `destructiveHint`, so
   most hosts will ask anyway.
5. **`tasks_get_run`** (`runId`): poll it. There is no streaming tool (see below), an agent step takes
   minutes, so poll every 15-30 seconds and say so instead of going quiet. Keep going until the
   status is terminal or a decision is parked.
6. **`decisions_list`** (`runId`): a run that stops advancing has usually PARKED on a human decision,
   and it waits indefinitely by design. Answer it with the other `decisions_*` tools
   (`decisions_incorporate`, `decisions_proceed`, `decisions_choose_fork`,
   `decisions_resolve_judge`, …) or leave it for a person.
7. **`notifications_list`**: the human-actionable tail, including the merge decision.
   `notifications_act` can merge a pull request, which is the other tool that spends.

For a run against a supplied brief with no board card and nothing pushed to a repository, the
`jobs_*` group is the same loop in one step: `jobs_create` → poll `jobs_get` → `jobs_cancel`.

To mount it on your own transport instead of stdio:

```ts
import { createCatFactoryMcpServer } from '@cat-factory/mcp-server'

const { server, tools } = createCatFactoryMcpServer({ baseUrl, apiKey })
await server.connect(myTransport)
```

## Mounting it yourself

Two exports for a deployment that wants to serve MCP from its own routes rather than have every caller
spawn a process:

```ts
import { handleMcpHttpRequest, refuseMcpMethod } from '@cat-factory/mcp-server/http'

app.all('/api/v1/mcp', async (c) => {
  const refused = refuseMcpMethod(c.req.method) // 405 + Allow: POST for GET/DELETE
  if (refused) return refused
  const key = authenticate(c) // your gate: this package never decides who may call
  return handleMcpHttpRequest(c.req.raw, {
    baseUrl: new URL(c.req.url).origin,
    apiKey: key.secret, // the CALLER's key, so every scope rule applies unchanged
    readOnly: key.scope === 'read',
    readOnlyReason: 'key-scope',
  })
})
```

It is **stateless**: one server per request, no session id minted, and a JSON response rather than an
event stream. That is not a simplification but the only shape that survives the runtimes this has to
serve — a Worker request lands on whichever isolate the edge picks, and a Node deployment scaled past
one instance has the same problem without sticky routing, so a session-keyed server works on one
process and fails intermittently in production.

Everything `handleMcpHttpRequest` reaches is therefore written against Web standards and imports no
Node built-in (`test/runtime-neutral.test.ts` enforces it, since the typecheck cannot): this package's
own `bin` is a Node process, but the hosted half is bundled into deployments' Workers, where `node:fs`
does not resolve at build time. That is also why `optionsFromEnv` takes its file reader as a
dependency rather than importing `readFileSync`. The `./http` subpath is the only entry with that
guarantee: the package root re-exports the stdio boot, whose `node:process` import a bundler cannot
shake out, so anything that bundles imports `@cat-factory/mcp-server/http` and never the root.

For a transport neither of these covers, `createCatFactoryMcpServer` returns the bare `Server`.

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
- **The output schema is deliberately looser than the spec.** Every tool that answers with a JSON
  object declares an `outputSchema` and returns `structuredContent` beside the text. But a caller's
  own MCP client VALIDATES a result against that schema, and `/api/v1` is additive forever, so the
  emitted version carries no `required`, no `enum`, no closed `anyOf` and no length or range bounds.
  Each of those would be a way for an older copy of this package to reject a newer deployment's
  honest answer. The known members of a vocabulary are stated in the field's description instead,
  where a new member cannot invalidate them, and a UNION asserts nothing at all beyond its
  discriminator in prose: not even `type`, since the variants a union gains later need not be
  objects.
- **Argument validation stops at the door.** Required path ids are checked so a request can be
  built at all; the body goes to the deployment, whose 422 names the field and is far more useful
  to a model than anything this layer could say.
- **A failure is tool content, not a protocol error.** A protocol error means the SERVER
  misbehaved and hosts do not show it to the model. A 422 with `code`, `details.reason` and the
  per-field `issues` is the most actionable thing this facade ever returns, so it is passed
  through verbatim rather than re-worded.

## The tool surface

One tool per exposed operation, named `<group>_<method>` to match the SDK call
(`client.tasks.create()` ⇄ `tasks_create`). The server reports the live count on startup and lists
the tools themselves over the protocol, which is the only place it cannot go stale:

| Group             | What it covers                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `jobs_*`          | Headless runs of a public inline pipeline against a brief.                                                             |
| `services_*`      | The board's service frames: list them, or create one (optionally repo-backed).                                         |
| `spec_*`          | A service's in-repo requirement tree and the Gherkin rendered from it. Read-only.                                      |
| `repos_*`         | The repositories a service can be backed with, and which service each already backs.                                   |
| `tasks_*`         | A task's whole lifecycle: create, edit, start, stop, retry, read its run, plus its dependencies and requirement links. |
| `pipelines_*`     | Which pipelines a task can be started with.                                                                            |
| `task_types_*`    | What a task can be created as, and the fields each kind accepts.                                                       |
| `notifications_*` | The human-actionable inbox, including the merge tail.                                                                  |
| `webhook_*`       | The workspace's outbound endpoints for notifications and run-lifecycle events.                                         |
| `usage_*`         | The billing period's metered budget position, and spend sliced by repo, ticket or run.                                 |
| `me_*`            | What the calling key is and what it may do.                                                                            |
| `decisions_*`     | A parked run's human decisions.                                                                                        |
| `debug_*`         | A run's recorded telemetry: LLM calls, agent context, infra logs.                                                      |
| `evidence_*`      | What a run proved: the verification report, the outcome summary, the captured artifacts.                               |
| `merge_records_*` | The evidence behind the auto-merge policy, with its per-class rollups.                                                 |
| `keys_*`          | The workspace's own API keys: provision, list, revoke.                                                                 |

**Three operations are deliberately absent**, and the server says so in its instructions rather
than leaving a model to conclude the platform cannot do it. `GET /api/v1/jobs/{id}/events` and
`GET /api/v1/tasks/{taskId}/events` are SSE streams, and a tool call returns one result over no
streaming channel: poll `jobs_get` / `tasks_get_run`, or consume the streams through an SDK. Adding
a bounded "wait for the run" tool would not fix this, because a run parked on a human decision waits
**indefinitely** by design, so any such tool is a timeout dressed up as an answer. The third is the
artifact byte download (`GET /api/v1/artifacts/{artifactId}/blob`): a tool result is
text or a declared content block, not an arbitrary byte stream, so list the artifacts with
`evidence_list_artifacts` and fetch the bytes over HTTP (or through an SDK) with the same key.

Generation FAILS on a new streaming operation nobody has classified, so the list above cannot go
quietly stale.

## Things a caller should know

- **`readOnlyHint` is set from the HTTP method.** `destructiveHint` and `idempotentHint` are set on
  the operations whose consequence is real money or a merged pull request (`tasks_start`,
  `tasks_retry`, `jobs_create`, `notifications_act`, `tasks_delete`) and left UNSET everywhere else.
  That asymmetry is deliberate: the protocol's default for an unset hint is already the cautious one,
  so a blanket `destructiveHint: false` over the cheap writes would lower a host's caution on a
  guess. `tasks_delete` is the case `readOnlyHint` cannot express at all: idempotent AND
  destructive.
- **Read-only mode is a convenience, not a boundary.** It removes tools from this server; the key
  still carries whatever scope it was minted with. Mint a `read`-scoped key for the boundary. The
  same goes for the two per-tool filters. (The hosted endpoint runs this the other way round: it
  DERIVES read-only from the key's scope, and the instructions name that as the cause so a model asks
  for a wider key rather than for a config edit.)
- **A result that does not fit is REFUSED, not truncated.** The message names how many characters
  there were, the limit, and the way out from either side: `limit` / `cursor` on the list endpoints,
  `offset` on the debug text reads, or a bigger `CAT_FACTORY_MCP_MAX_RESULT_CHARS`. Half an object
  cannot satisfy the output schema it was cut out of, and a truncated prefix spends the whole cap on
  a document whose own note tells the model not to read it.
- **Results are compact JSON.** Two-space indentation reads better to a human than to a model and
  costs roughly a third of every result in whitespace; a host that wants it pretty can re-print the
  structured content it also gets.
- **Spending tools are called out in the server's instructions**, derived from those same
  annotations rather than restated in prose, so a tool withheld on this server is not named as one to
  be careful with.

## Development

```sh
pnpm --filter @cat-factory/mcp-server build
pnpm --filter @cat-factory/mcp-server test:run
pnpm gen:sdk      # regenerate the tool table after a contracts change
pnpm check:sdk    # the CI drift guard
pnpm check:publish   # after a build: the empty-shell / publint / attw guard
```

Three layers of coverage, and the split is about what each CAN see:

- **Unit tests** (`test/`) drive a **real** MCP client over an in-memory transport against a real SDK
  client whose `fetch` is stubbed, so a tool that lists but cannot be called fails a test rather than
  shipping. `test/stdio.test.ts` covers the executable's rules (connect before announcing, every
  human-readable byte off stdout, refuse rather than start) without spawning anything.
- **The two MCP phases of `backend/internal/sdk-smoketest`** drive both access paths against one real
  backend: `--only=mcp` spawns the built `dist/bin.js` as a real process, `--only=mcp-hosted` connects
  a real Streamable HTTP client to that deployment's `POST /api/v1/mcp`. Either one is the only thing
  that can see the published output schemas DISAGREE with what the deployment actually answers,
  because the client validates them; running both against one board is what would catch the two paths
  answering differently.
- **`pnpm check:publish`** covers the shape this package is most exposed to: one `bin` entry pointing
  at a gitignored `dist`, which is exactly how two other packages once reached npm as empty shells.
