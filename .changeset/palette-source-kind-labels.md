---
'@cat-factory/app': patch
---

The command palette names the kind of each source it offers to connect or manage: "Connect Linear
(documents)" and "Connect Linear (tracker)" instead of "Connect Linear" twice, and "Connect Figma
(designs)" for a design source. Linear is both a document source and a task source, and the two are
separate connections that open different dialogs.

The palette keys `layout.commandBar.cmd.sourceConnect` and `sourceManage` are removed. A layer that
overrides them must move its copy to the six new keys: `documentSourceConnect`,
`documentSourceManage`, `designSourceConnect`, `designSourceManage`, `taskSourceConnect` and
`taskSourceManage`. The old keys are no longer read, so an override left on them has no effect.
