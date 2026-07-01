---
'@cat-factory/app': minor
---

The SPA now consumes the `cat-factory k3s` guided-setup deep-link (guided-setup slice 4). On
load, `?infraSetup=local-k3s&…` opens Infrastructure → Test environments with the Local k3s
engine form **pre-filled** from the link's non-secret params (label, apiserver URL, namespace +
ingress-host templates, skip-TLS), then strips the params from the URL (mirroring the `?invite=`
handling). The ServiceAccount token is deliberately never in the link — the CLI prints it once for
the user to paste before Test → Save. The Local k3s engine form also gains an **Auto-setup with the
CLI** hint surfacing the `cat-factory k3s` command with a copy button. Completes the guided-setup
initiative; the `docs/initiatives` tracker is superseded by ADR 0008.
