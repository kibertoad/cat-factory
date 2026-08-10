---
'@cat-factory/acceptance': patch
---

Read the acceptance suite's configuration from a `.env` beside its vitest config. The file was
already gitignored and referenced, but nothing loaded it, so a fully configured `.env` still
refused with every variable reported as missing. A variable exported in the shell wins over the
file, so a one-off `ACCEPTANCE_RUN_ID=latest` still resumes.
