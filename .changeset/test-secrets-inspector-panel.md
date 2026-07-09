---
'@cat-factory/app': minor
---

Add the sensitive test-credentials inspector panel (Slice C frontend): a per-service-frame
`ServiceTestSecrets` panel + `stores/testSecrets` for configuring the SEALED test secrets the
Tester needs to exercise a third-party integration. Values are write-only and the editor
replaces the whole set; the panel carries an unmistakable sensitivity + replace-all warning and
hides itself when the backend store is unconfigured. Fully localized in all shipped locales.
