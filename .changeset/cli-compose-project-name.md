---
'@cat-factory/cli': patch
---

Generate the local Compose project name from the setup project name to prevent deployments with different names from sharing containers and database volumes under the default `local` project.
Regenerating an existing deployment selects a new database volume; the previous volume remains intact.
