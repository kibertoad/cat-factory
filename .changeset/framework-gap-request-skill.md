---
---

Repo tooling only: a `framework-gap-request` skill for handling a downstream consumer's report of
framework gaps. Encodes the intake this repo already ran twice (ADR 0040 / 0044 / 0045): capture the
measured versions and workarounds, re-verify every finding against HEAD, dispose of the defect and
the requester's remedy separately, then land the tracker or the fix.
