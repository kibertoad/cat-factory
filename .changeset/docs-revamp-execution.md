---
'@cat-factory/contracts': patch
---

Reserve `NOTIFICATION_RETENTION_DAYS` and `PROVISIONING_LOG_RETENTION_DAYS`. Both are read by the
retention sweep on every facade and neither was covered by a reserved prefix family, so a tool
server or a generative integration could name either as the KEY its credential is looked up by and
have the resolver read the platform's own value off the environment. They are exact names rather
than new `NOTIFICATION_` / `PROVISIONING_` families, because each family holds one platform variable
and reserving the namespace would newly refuse credential keys a deployment may already have
registered under it.

Documenting the two variables is what surfaced this: `scripts/check-reserved-env-keys.mjs` fails
when a documented variable is not reserved, which is the guard working as designed.

The rest of the change is documentation: executing the repo half of the documentation revamp
(`docs/initiatives/documentation-revamp.md`), which splits each doubly-documented topic by depth
between this repo and catfactory.ai.
