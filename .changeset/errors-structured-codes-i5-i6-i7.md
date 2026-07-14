---
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
---

Classify errors by structured fields, not strings, on three more paths (error-message initiative I5/I6/I7).

- **I7 — installation-token-gone:** the App token mint now throws a named
  `InstallationTokenMintError` carrying the HTTP `status` as a field, wrapped once at the mint site
  in `GitHubAppAuth`. The stale-installation reconcile (`reconcileStaleRepos`) classifies via the
  `installationTokenMintStatusOf` extractor — an `instanceof` check deliberately specific to the mint
  error, so a repo-level 404 can never be mistaken for a gone installation — and the log-level check
  reads the repo-level `GitHubApiError.status` structurally too. Both errors throw in-process, so
  there is NO message-regex fallback (we target current installations only). The elaborated C3 remedy
  text is free to change without breaking the tombstone decision.
- **I5 — delete the string-fallback classifiers:** with the structured `RunnerJobView.evicted` field
  and the harness `failureCause` now minted by every in-repo transport, the superseded error-string
  fallbacks are removed — `classifyAgentFailure` / `classifyBootstrapFailure` / `classifyRepairFailure`
  are gone (the sites default to the coarse `agent`), and `evictionKindOf`'s string fallback (plus
  `isTransientEviction` and the exported `TRANSIENT_EVICTION_MARKER`) is dropped in favour of reading
  the `evicted` field directly. `isContainerEvictionError` is kept for the dispatch-time eviction
  throw, which carries no job view. Backend/runtime-only; no executor-harness image change.
- **I6 — first-wrap-point rule:** codified (the named boundaries — git stderr, pg driver errors,
  kubectl/k3s stderr — already conformed): third-party text is classified once, where it enters the
  system, into a named error with a machine field; nothing downstream re-parses the prose.
