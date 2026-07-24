---
'@cat-factory/executor-harness': minor
'@cat-factory/server': patch
'@cat-factory/local-server': patch
---

Fix per-job state leaking across concurrent native (`LOCAL_NATIVE_AGENTS`) runs, and stop
native runs writing into the developer's own home directory.

Native mode already ran jobs in parallel — one long-lived harness host process starts every job
immediately, each in its own throwaway clone. But three pieces of per-job state were staged in
process- or HOME-globals, which are only per-job when the process is. That holds for a container
and not for the shared native host process, whose `HOME` is the developer's own:

- **`~/.npmrc` was written, and deleted.** Every agent job configures private-registry auth, and
  a job with no registry entries cleared the file — correct for a reused warm-pool container,
  destructive against the developer's real npm config, on essentially every native run. A native
  job now gets its own npmrc under a per-job directory, pointed at by `npm_config_userconfig` and
  seeded from the developer's file so their registries and proxy still apply. Theirs is never
  written and never removed.
- **A repo-sourced Claude Skill was installed into `~/.claude/skills/<name>/`.** It outlived the
  run in the developer's personal setup, and two concurrent jobs carrying same-named skills from
  different repos overwrote each other. The native install now happens only into an isolated
  `CLAUDE_CONFIG_DIR`; an ambient run reads the skill from the checkout's `.cat-context/skill/`,
  the same fallback codex always used. The prompt follows: `renderSkillForHarness` now keys off
  ambient auth as well as the harness, so such a run gets the skill's instructions folded in
  rather than a pointer to an install that never happened.
- **The Tester's secrets were set on `process.env` and restored afterwards.** Two overlapping
  Tester runs in one harness process would read each other's values, and whichever finished
  first would delete the other's mid-run. They now ride explicit child env
  (`RunOptions.agentEnv` → `SubscriptionRunOptions.extraEnv`) merged at spawn, so the agent's
  shell tools still read them as `$KEY` with no shared mutable state.

Container behaviour is unchanged throughout.

Two consequences of the npmrc move are handled with it: the stand-up/validation commands the
HARNESS spawns (rather than the agent) are passed the job env explicitly, so they keep the job's
registry auth on the native path; and the developer's own credentials, now seeded into the job's
npmrc, are registered for output redaction alongside the job's. Note `npm_config_userconfig` is
honoured by npm and pnpm but not yarn, so a yarn checkout on the native path sees only the
developer's own registries.
