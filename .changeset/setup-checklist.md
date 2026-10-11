---
'@cat-factory/app': minor
---

Add a setup checklist (Configuration → Setup checklist, or the palette) for people who can change the workspace setup. It lists every prerequisite for "a task can run and merge" (model, source control, where agents run, test environments, screenshot storage) with its state and one action per row, composed from the probes the setup banners and startup dialogs already read. "Checking" and "missing" are separate states, so a probe that has not answered never shows as a gap. The banners and dialogs are unchanged.
