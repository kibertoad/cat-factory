---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

Let a code-registered prompt fragment name a LIVING document.

A `documentRef` on a deployment-registered fragment used to be refused at boot, because every
document source authenticated per workspace and there was no deployment-wide credential to read one
with. A deployment now configures its own (`DOC_SOURCE_<SOURCE>_<FIELD>`, the field names taken from
each provider's existing connect-form declaration), and a `builtin`-tier `documentRef` resolves
through a new `DeploymentDocumentResolver` port, version-probed and cached under one
deployment-wide group so a hundred workspaces folding one standard cost one fetch and one
invalidation.

The deployment's own credentials are read from the environment and nothing else. `DOCUMENT_SOURCES`
governs which sources a WORKSPACE may connect, and `DOCUMENTS_ENABLED` and the connection encryption
key govern whether tenant connections are stored at all; none of the three has any bearing on a
standard the deployment configured centrally, whose credentials live in plaintext variables and are
never persisted. So setting `DOC_SOURCE_NOTION_API_TOKEN` is the whole configuration, with no
unrelated prerequisite to discover.

`github` is the exception and it is declared, not inferred: its credential is a workspace's App
installation, so the new `deploymentScoped` source trait is false for it and both boot validation
and the provider refuse the scope. Boot now refuses only a `documentRef` this deployment cannot
serve, naming which of the two causes applies.

An unreachable source still degrades to the fragment's registered body, but no longer silently: the
fallback logs a warning naming the fragment, tier and source, because the prompt is byte-identical
either way and nothing downstream could otherwise tell a stale standard from a current one.

In mothership mode the credential stays on the mothership and the node reads the resolved body over
`POST /internal/prompt-fragments/document-bodies`.

`DocumentSourceProvider.fetchDocument` / `probeVersion` now take `workspaceId: string | null`, where
`null` is the deployment scope. An internal interface with no external consumers.
