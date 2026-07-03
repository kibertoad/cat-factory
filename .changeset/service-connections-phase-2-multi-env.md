---
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/executor-harness': patch
---

Service connections Phase 2 — multi-env provisioning. A `deployer` step now fans out over
the task's own service frame PLUS each connected involved-service frame, provisioning one
ephemeral environment per frame (dispatched provider-before-consumer, parked between), each
keyed per `(blockId, frameId)` so the fan-out no longer clobbers itself. Already-ready peers
are injected into a later provision as `{{input.peerEnvUrls}}`, the agent context gains
`involvedServices` (title + connection description + the peer's live env URL, read-time
stale-filtered), and the Tester infra spec gains a `peerEnvironments` map so a cross-service
integration test can reach a peer's real environment.
