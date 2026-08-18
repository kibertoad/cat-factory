---
---

Docs only: the first external-API sweep record, under `docs/internal/external-api-sweep.md`. Every
hand-written call against a service we do not run, checked against the vendor's live documentation.

Three surfaces have already moved and are the reason to read it: Confluence's v1
`GET /wiki/rest/api/content/{id}` was retired on 2025-04-30 and two of our three Confluence calls
target it; incident.io publishes no POST on `/v2/incident_updates`, so the post-release enrichment
has never worked and a bare `catch {}` was hiding that; and MCP revision `2026-07-28` removed the
`initialize` handshake our tool-server probe pins, with the spec rating our era-combination as
failing. Two more carry dates: Langfuse's ingestion API sunsets on Cloud 2026-11-16, and GitHub's
`2022-11-28` pin ends support 2028-03-10.

The fixes are separate PRs; this one records and hands off.
