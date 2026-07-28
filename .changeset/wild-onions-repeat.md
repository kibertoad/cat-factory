---
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Make a selected initiative offer to delete the INITIATIVE (not "delete service"), and give the
planning run the ordinary run surfaces — the inspector execution panel and Focus view — so a
stalled plan can be discarded and re-run. The interviewer gate now implements the shared spine's
`resetForFreshRun`, so a re-run starts a clean interview instead of resuming the previous run's
spent round counter.
