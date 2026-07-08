---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/executor-harness': patch
---

feat(testing): sealed sensitive test credentials, delivered to the Tester out of band

Add a SEALED per-service store for sensitive testing credentials (e.g. a third-party API
token a Tester needs), the sibling of the non-sensitive test-credential pools. Values are
encrypted at rest by the facade `SecretCipher` (info tag `cat-factory:test-secrets`, mirroring
`observability_connections`) and delivered to the Tester container **out of band**: decrypted at
dispatch, carried on a dedicated job-body field the agent-context snapshot allow-list omits, and
injected by the harness as container environment variables the agent reads (`$KEY`). The tester
prompt advertises only each secret's key + description (never the value). Per service frame,
resolved up the frame chain like release-health config; mirrored across both runtimes (D1 +
Drizzle) with a cross-runtime conformance assertion.

New API: `GET|PUT|DELETE /workspaces/:ws/services/:blockId/test-secrets` (values write-only).

This is Slice C of the tester-environment-access initiative; the Test Data Seeder agent
(Slice D) is a tracked follow-up. See docs/initiatives/tester-environment-access.md.
