---
---

Judge the image-harness changeset guard on the bumps a branch authored, read off the changeset
front matter rather than off file paths, so a changeset pending on the base stops failing every
unrelated PR and an uncommitted one is still caught by a local pre-commit run.
