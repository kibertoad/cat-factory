---
---

chore(ci): run pure pre-merge gates (lint/format, publish integrity, repo guards, workflow
security) on PRs only, not on push to main. They give no post-merge signal and can't block an
already-merged commit; push to main keeps the checks with real merge-race value (build/typecheck
incl. the Drizzle lineage check, the test lanes, container acceptance).
