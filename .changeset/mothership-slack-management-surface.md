---
'@cat-factory/server': minor
'@cat-factory/node-server': minor
---

Mothership mode: expose the Slack integration management surface over the persistence RPC.

Adds a new `accountField` persistence-RPC scope rule (the account-owned mirror of `workspaceField`,
binding on an `upsert(record)`'s `accountId` field) and allow-lists the Slack settings repositories
so the connect / route / member-map panels persist in mothership mode:
`slackConnectionRepository` (`getByAccount`/`upsert`/`softDelete` — the bot token rides a sealed
`tokenCipher`, so only ciphertext crosses the machine API), `slackSettingsRepository`
(`getByWorkspace`/`upsert`) and `slackMemberMappingRepository` (`getByAccount`/`upsert`). The Node
facade routes the three Slack repos through the `pickRepoSource` seam inside `selectNodeSlackDeps`,
so both the management services and the `SlackNotificationChannel` read the remote-backed repos.
`slackConnectionRepository.getByTeam` (the global inbound-OAuth teamId lookup) stays
mothership-internal, and mothership-side Slack delivery for a hosted teammate remains a later
secrets-delegation slice.
