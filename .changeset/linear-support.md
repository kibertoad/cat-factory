---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Add Linear support as a document source and issue tracker. Linear Docs can be
imported as task context (mirroring Notion/Confluence); Linear issues can be
imported and linked to board blocks (mirroring Jira/GitHub Issues); the `tracker`
pipeline step can file issues into Linear; and PR writeback comments on and
resolves the linked Linear issue. Authentication is a per-workspace personal API
key (sealed at rest), behind a shared GraphQL client shaped so OAuth can be added
later. Adds one nullable `linear_team_id` column to `tracker_settings` (mirrored
across D1 and Postgres) for the team new issues are filed under.
