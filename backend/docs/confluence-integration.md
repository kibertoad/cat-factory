# Confluence integration

Link requirements, RFCs and PRDs from Confluence Cloud to a workspace's board:
import a page, expand it into board structure (services → modules → tasks), or
attach it to a task as extra context the agents read during execution.

Like the GitHub integration, this is **opt-in** and assembled only when
configured — the existing core and tests are untouched when it is off.

## Enabling it

Per-workspace site credentials (base URL, account email, API token) are entered
in the app and stored in D1; there are no Confluence secrets in `wrangler.toml`.
Only the feature flag is global:

```toml
# wrangler.toml [vars]
CONFLUENCE_ENABLED = "true"
# Doc → board planner: "llm" (default) uses the configured agent model; "headings"
# forces the deterministic heading parser.
CONFLUENCE_PLANNER = "llm"
```

In `llm` mode the planner reuses the agents' default model
(`AGENT_DEFAULT_PROVIDER` / `AGENT_DEFAULT_MODEL`) via the provider-agnostic
`ModelProvider` port. If no provider credential is usable, or a response can't be
parsed, it degrades to the deterministic heading parser, so import/plan/spawn
always work.

Each workspace owner connects their own site with an Atlassian **API token**
(`id.atlassian.com → Security → API tokens`); the backend authenticates to
Confluence Cloud with HTTP Basic (`email:token`). The token is stored
plaintext-at-rest in D1 (same posture as the cached GitHub installation token)
and is never returned on the wire.

## HTTP API

All endpoints are workspace-scoped under `/workspaces/:workspaceId` and return
`503` when the integration is unconfigured.

| Method & path                             | Purpose                                             |
| ----------------------------------------- | --------------------------------------------------- |
| `GET /confluence/connection`              | Current connection (no token), or null              |
| `POST /confluence/connect`                | Connect: `{ baseUrl, accountEmail, apiToken }`      |
| `DELETE /confluence/connection`           | Disconnect                                          |
| `POST /confluence/import`                 | Fetch + persist a page: `{ page }` (id or URL)      |
| `GET /confluence/documents`               | List imported documents                             |
| `POST /confluence/plan`                   | Preview the board plan for `{ pageId }` (no writes) |
| `POST /confluence/spawn`                  | Apply structure: `{ pageId, frameId? }`             |
| `POST /confluence/documents/:pageId/link` | Attach a doc to a block: `{ blockId }`              |

`spawn` without `frameId` creates new top-level frames; with it, the plan's
modules and tasks are added inside that existing service frame. A document linked
to a block is resolved at execution time and injected into the agent prompt (see
`userPromptFor` in `core/src/modules/agents/agent-catalog.ts`).

## Layout

- Wire contracts: `packages/contracts/src/confluence.ts`
- Core module: `packages/core/src/modules/confluence/` (connection, import,
  planner, link services) + ports `confluence-client.ts` /
  `confluence-repositories.ts`, assembled by `createConfluenceModule` in
  `core/src/container.ts`
- Worker infra: `confluence/FetchConfluenceClient.ts`, the two
  `D1Confluence*Repository` classes, `selectConfluenceDeps` in
  `infrastructure/container.ts`, and `ConfluenceController.ts`
- Schema: migration `0005_confluence.sql`
- Tests: `test/integration/confluence-*.spec.ts` with `FakeConfluenceClient` and
  the `confluenceDeps()` helper
