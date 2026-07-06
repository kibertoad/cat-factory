---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Fix authenticated git clone/push failing with `fatal: unable to get password from user`. The
non-interactive-auth hardening added `-c credential.interactive=false` to every git invocation,
but modern git (≥ 2.47 — the executor image and host git) honors `credential.interactive` and
treats invoking `GIT_ASKPASS` as interactive, so it skipped the harness askpass entirely and
never sent the PAT — breaking every authenticated push on both the native and container paths (a
public base repo still clones anonymously, so it only surfaced at push, looking intermittent).
The flag is removed; the emptied credential-helper list plus `GIT_TERMINAL_PROMPT=0` /
`GCM_INTERACTIVE=never` already defeat the Git Credential Manager popup it was meant to guard
against. Bumps the runner image (and the local-mode pin) to `cat-factory-executor:1.37.1`.
