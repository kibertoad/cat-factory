---
'@cat-factory/app': patch
---

The command palette names the kind of each source it offers to connect or manage: "Connect Linear
(documents)" and "Connect Linear (issues)" instead of "Connect Linear" twice. Linear is both a
document source and a task source, and the two are separate connections that open different
dialogs. The palette keys `sourceConnect` and `sourceManage` are replaced by a document and a task
pair, in every locale.
