# Document sources

Link requirements, RFCs and PRDs from external document sources to a workspace's
board: import a page, expand it into board structure (services → modules →
tasks), or attach it to a task as extra context the agents read during
execution.

The integration is **source-agnostic**. A `DocumentSourceProvider` encapsulates
everything specific to one source (credential validation, page-id parsing,
fetching, body → Markdown), and the rest of the stack — connection/import/plan/
spawn/link services, the D1 tables, the HTTP surface and the frontend — is
shared. Two providers ship today:

- **Confluence Cloud** — HTTP Basic (account email + API token), storage-format
  XHTML bodies.
- **Notion** — a single internal-integration token (Bearer), block-based bodies.

Adding a third source is just another provider: implement
`DocumentSourceProvider` (a `kind`, a `descriptor`, `normalizeConnection`,
`parseRef`, `fetchDocument`) and register it in `selectDocumentsDeps`.

This integration is **always on**: tenants connect their own sources
interactively through the app, so there is no enable flag to forget. The one
thing it requires is a master key to encrypt the per-workspace credentials at
rest — and to make a misconfiguration impossible to miss, the worker **fails to
boot** (a loud config error) when the key is unset rather than silently dropping
the feature from the UI.

## Configuring it

Per-workspace credentials are entered in the app and stored (encrypted) in D1;
there are no source secrets in `wrangler.toml`. A couple of knobs are global,
plus the one required secret — the master key used to encrypt the per-workspace
source credentials at rest:

```toml
# wrangler.toml [vars]
# Optional allow-list of sources to register (default: all known sources).
DOCUMENT_SOURCES = "confluence,notion"
# Doc → board planner: "llm" (default) uses the configured agent model; "headings"
# forces the deterministic heading parser.
DOCUMENT_PLANNER = "llm"
```

```sh
# Shared master key for credential encryption at rest (REQUIRED — config load throws
# without it; set as a secret, never commit it). One key backs every integration; the
# cipher domain-separates per integration via its HKDF `info` tag:
openssl rand -base64 32 | wrangler secret put ENCRYPTION_KEY
```

In `llm` mode the planner reuses the agents' default model
(`AGENT_DEFAULT_PROVIDER` / `AGENT_DEFAULT_MODEL`) via the provider-agnostic
`ModelProvider` port. If no provider credential is usable, or a response can't be
parsed, it degrades to the deterministic heading parser, so import/plan/spawn
always work.

Credentials are stored encrypted at rest in D1 — the per-source JSON bag is
sealed with AES-256-GCM (the same `WebCryptoSecretCipher` envelope the
environments integration uses, under a documents-scoped HKDF `info`) before it
is written, and decrypted only on the import path. They are never returned on the
wire. Rows written before encryption was introduced are read back as legacy
plaintext and re-encrypted on the next write.

- **Confluence**: each workspace owner connects their own site with an Atlassian
  **API token** (`id.atlassian.com → Security → API tokens`); the backend
  authenticates with HTTP Basic (`email:token`). The stored base URL is
  SSRF-guarded (https, public host).
- **Notion**: create an **internal integration**
  (`notion.so/my-integrations`), share each page with it, and paste the token.
  The API host is fixed (`api.notion.com`), so there is no SSRF surface.
- **GitHub** (repo docs — READMEs / RFCs / notes under `docs/`): rides the
  workspace's installed GitHub App (or PAT in local mode), so it stores **no
  per-workspace credential and needs no separate connect step**. It is reported as a
  live connection as soon as the App is installed — the provider's
  `resolveImplicitConnection` resolves the workspace's installation, and
  `DocumentConnectionService` surfaces it in `listConnections` / `requireConnection`
  without a stored marker row (an explicit stored connection, if one exists, still
  wins). This mirrors the GitHub-issues **task** source's App-presence availability.

## HTTP API

All endpoints are workspace-scoped under `/workspaces/:workspaceId` and return
`503` when the integration is unconfigured. `:source` is `confluence` | `notion`.

| Method & path                                 | Purpose                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `GET /document-sources`                       | Configured sources + their connect/import descriptors      |
| `GET /document-sources/connections`           | The workspace's live connections (no credentials)          |
| `POST /document-sources/:source/connect`      | Connect: `{ credentials: { … } }`                          |
| `DELETE /document-sources/:source/connection` | Disconnect a source                                        |
| `GET /documents`                              | List imported documents (all sources)                      |
| `POST /document-sources/:source/import`       | Fetch + persist a page: `{ ref }` (id or URL)              |
| `POST /document-sources/:source/plan`         | Preview the board plan for `{ externalId }` (no writes)    |
| `POST /document-sources/:source/spawn`        | Apply structure: `{ externalId, frameId? }`                |
| `POST /documents/link`                        | Attach a doc to a block: `{ source, externalId, blockId }` |

`spawn` without `frameId` creates new top-level frames; with it, the plan's
modules and tasks are added inside that existing service frame. A document linked
to a block is resolved at execution time and injected into the agent prompt (see
`userPromptFor` in `core/src/modules/agents/agent-catalog.ts`).

The `credentials` bag a source expects is described by its descriptor
(`GET /document-sources` → `credentialFields`), so the connect UI renders
generically — no per-source form is hard-coded in the frontend.

## Layout

- Wire contracts: `packages/contracts/src/documents.ts`
- Core module: `packages/core/src/modules/documents/` (connection, import,
  planner, link services + the shared `documents.logic.ts`; provider-specific
  pure logic in `confluence.logic.ts` / `notion.logic.ts`) + ports
  `document-source.ts` / `document-repositories.ts`, assembled by
  `createDocumentsModule` in `core/src/container.ts`
- Worker infra: the providers `documents/ConfluenceProvider.ts` /
  `documents/NotionProvider.ts`, the two `D1Document*Repository` classes,
  `selectDocumentsDeps` in `infrastructure/container.ts`, and
  `DocumentSourceController.ts`
- Schema: migration `0012_document_sources.sql` (supersedes the Confluence-only
  `0005_confluence.sql`, migrating any live rows across before dropping them)
- Tests: `test/integration/documents-*.spec.ts` with `FakeDocumentSourceProvider`
  and the `documentsDeps()` helper
