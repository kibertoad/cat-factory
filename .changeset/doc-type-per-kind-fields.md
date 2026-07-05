---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/app': minor
---

Document tasks: per-kind specific fields. The create-task form now collects the fields that
matter for the chosen document kind (PRD target users + success metrics, RFC alternatives +
rollout concerns, ADR decision drivers + considered options, runbook when-to-use + escalation,
research question + options to compare, API surface), and the author agents fold them into the
brief as required content for the matching template sections. The fields live on the sparse
`taskTypeFields` bag (no migration) with `DOC_KIND_FIELDS` as the single source of truth shared
by the form and the prompts.
