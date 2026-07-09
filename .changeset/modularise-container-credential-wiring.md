---
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Modularisation split #4 (first sub-slice): extract the sealed credential /
subscription / provider-key service builders out of each facade's oversized
`container.ts` into a per-concern `wireCredentialServices.ts` helper, re-imported at
their original call sites. Pure move — identical signatures, bodies and wiring on both
runtimes; behaviour, public API and DI are unchanged. Establishes the `wire*.ts` target
pattern for the remaining container concern groups (GitHub, merge/notifications, content
sources, infrastructure).
