---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Let a deployment register its own task source in code. The source vocabulary is now
`builtin picklist ∪ <namespace>:<name>`, matching the shape task types already use, so a
deployment's provider on the app-owned `TaskSourceRegistry` is served by connect, import,
search, bug hunt and webhook intake without a fork.

The built-ins keep their bare ids, so no persisted row changes. A bare non-built-in id still
fails validation, keeping a typo distinguishable from a registration.

Issue-intake board scope gains an opaque `boardId` leg for registered sources; without it a
registered source's board id fell through to the GitHub field.
