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

Like the GitHub integration, this is **opt-in** and assembled only when
configured — the existing core and tests are untouched when it is off.

## Enabling it

Per-workspace credentials are entered in the app and stored (encrypted) in D1;
there are no source secrets in `wrangler.toml`. The feature flag and a couple of
knobs are global, plus one secret — the master key used to encrypt the
per-workspace source credentials at rest. The integration refuses to assemble
without the key, so credentials are never persisted in plaintext:

```toml
# wrangler.toml [vars]
DOCUMENTS_ENABLED = "true"
# Optional allow-list of sources to register (default: all known sources).
DOCUMENT_SOURCES = "confluence,notion"
# Doc → board planner: "llm" (default) uses the configured agent model; "headings"
# forces the deterministic heading parser.
DOCUMENT_PLANNER = "llm"
```

```sh
# Service-level master key for credential encryption at rest (required when
# enabled; set as a secret, never commit it):
openssl rand -base64 32 | wrangler secret put DOCUMENTS_ENCRYPTION_KEY
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
