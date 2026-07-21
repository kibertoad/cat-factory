---
'@cat-factory/app': patch
---

PR-review UI + personal-password cache hygiene (ADR 0026 D2.2 + D7):

- The PR deep-reviewer no longer claims a "Slicing…" phase purely because the parent stream emitted no todo list. A subagent-driven review never writes a parent todo plan, so the empty-list state is now a NEUTRAL "Reviewing…" (`planning`) phase, and per-slice status appears the moment a real plan exists.
- The personal-subscription password cache is scoped per installation and per user (`cf.personal-pw:<hash(apiBase)>:<userId>`) instead of the bare origin-only `cf.personal-pw`, so a cached password is never offered to another installation or user on a shared origin. The retired global key is purged on read.
