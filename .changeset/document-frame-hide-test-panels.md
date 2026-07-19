---
'@cat-factory/app': patch
---

fix(app): hide the test-infrastructure, test-credentials and post-release-health inspector panels for a `document`-type frame (a doc repo stands up no test environment and ships no release, so those windows don't apply). The add-service-from-repo modal likewise skips the inline "Test infrastructure" step for a document repo.
