---
'@cat-factory/integrations': patch
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/cli': patch
'@cat-factory/app': patch
---

Report what actually went wrong when a connection test fails.

Every "Test connection" button rendered the thrown error's `message`, which on Node is undici's
generic `fetch failed` wrapper; the real failure hangs off the cause chain. A stopped k3s cluster,
an untrusted certificate, an unresolvable host and a firewalled port all read identically. A new
kernel helper flattens the chain into the exact failure and adds a remedy for each cause it
recognises, wired into the Kubernetes environment + runner probes, the shared HTTP probe behind the
manifest environment/runner-pool providers, the Cloudflare preview probe, and the Compose probe. An
unrecognised failure is still reported verbatim, with no hint.

The failure CLASS also rides the wire as `ConnectionTestResult.failureCause` (a new optional field,
with the vocabulary in `@cat-factory/contracts`), so the connect forms state what failed in the
operator's own language and keep the backend's English account, which names the concrete host and
the remedy, as the detail beneath it.

A pasted ServiceAccount token is also checked on the field now: a token copied across a wrapped
terminal line carries a newline that no HTTP header can hold, and it previously surfaced as an
opaque request failure minutes later. The impossible case blocks Test and Save and is refused by
the apiserver client; a still-base64 `.data.token` value or a non-JWT shape is an overrulable
warning, since an apiserver using static bearer tokens accepts arbitrary strings.

The `cat-factory k3s` deep link now scrolls the Infrastructure window to the Kubernetes section
instead of opening at the top of the tab, and the CLI no longer lists the ServiceAccount among the
values to type into a form that has no such field.
