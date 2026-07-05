---
'@cat-factory/app': patch
---

Kubernetes engine (Infrastructure → environments) UX:

- **Auto-probe a saved connection on open.** When the configurator shows an already-registered
  kube handler it now runs the saved-connection test automatically (reusing the server-side
  token), so the operator sees a LIVE verdict instead of only the static "connection
  established" card — which merely means a config is stored and hid a silently-expired token or
  a recreated cluster.
- **Recommend a long-lived token.** The local-k3s form hint now steers the operator to a
  durable token (flagging that a plain `kubectl create token` expires in 1 hour, and to add
  `--duration=720h` or create a non-expiring `kubernetes.io/service-account-token` Secret).
  Mirrored across all locales.
