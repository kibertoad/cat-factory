---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Improve the Kubernetes per-type engine configurator:

- **k3s feedback** — picking the `local-k3s` engine now prefills the engine form's loopback
  defaults (API server `https://127.0.0.1:6443`, label, skip-TLS) and shows a hint banner that
  explains the prefill and how to mint a ServiceAccount token, instead of leaving the form
  unchanged. Switching back to `remote-kubernetes` clears those local-only defaults. k3s/k3d/kind
  share the same loopback defaults, so they remain one preset rather than separate options.
- **Test connection** — the Kubernetes engine form (workspace + per-user override) gains a working
  "Test connection" button. A new `POST /workspaces/:ws/environments/handlers/test` endpoint lowers
  the engine config to a backend config and reaches the apiserver with the supplied token (nothing
  persisted), reusing the existing connection-probe path. Reported as `{ ok, message }`.
