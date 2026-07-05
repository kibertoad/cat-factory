---
'@cat-factory/integrations': patch
---

Make a failed Kubernetes apiserver connection test actionable instead of dumping the raw
`apiserver responded 401: {"kind":"Status",…}` body. A shared
`apiServerConnectionFailureMessage` helper now maps the auth verdicts to a human message: a
**401** is explained as an authentication failure (expired / no-longer-recognised token, NOT
RBAC) with the two common local-cluster causes — a short-lived `kubectl create token` token
(default 1 hour) that aged out, or a recreated/reinstalled cluster whose token-signing keys
rotated and invalidated every earlier token — plus the fix (mint a fresh long-lived token and
paste it in). A **403** is explained as an RBAC denial naming the attempted operation. Wired
into both `testConnection`s (the `kubernetes` environment provider and the Kubernetes runner
transport); any other status keeps the raw `status: body` shape.
