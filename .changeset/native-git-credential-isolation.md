---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Force fully non-interactive git auth in the harness so native local mode never triggers a Git
Credential Manager popup. Every git invocation now empties the host credential-helper list
(`-c credential.helper=`) and disables interactive credential backends, so git falls back to the
harness's own askpass PAT instead of the host's GCM — which on Windows either stole focus with a
stray auth window or, when modal, hung the git command (clone/fetch/push) until it timed out. A
per-command git timeout is now surfaced as an explicit stall (naming the likely causes) rather
than a contentless "Command failed", and a genuine git failure now folds in git's stderr.

Bumps the executor-harness image tag (and the matched `RECOMMENDED_HARNESS_IMAGE` pin) to 1.31.5.
