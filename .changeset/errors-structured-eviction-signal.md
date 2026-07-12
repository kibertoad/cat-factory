---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/integrations': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
---

Structured container-eviction signal (error-message initiative I1). A container eviction is now
carried on a typed `RunnerJobView.evicted` field (`'crash'` | `'transient'`, the new
`ContainerEvictionKind`) minted by every runner transport (Cloudflare, the shared local
`harnessHttp`, the local container/pool/process/native-routing transports, and Kubernetes/EKS),
forwarded through `AgentJobUpdate`, and read by the execution / bootstrap / env-config-repair
consumers via the new `evictionKindOf` extractor. The `(container evicted or crashed)` sentinel +
the transient marker are PRESERVED as the fallback for an older producer, so nothing that still
matches the string breaks — the structured field is simply the load-bearing signal now, replacing
the regex as the primary classification channel.
