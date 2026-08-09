---
---

Docs and CI guards only: the documentation revamp's next phase, closing item 12 and fixing a
breakage the previous one introduced (`docs/initiatives/documentation-revamp.md`).

The previous phase reduced `mcp-tool-servers.md` (723 → 347) and `debug-api.md` (433 → 207) toward
catfactory.ai pages that were never landed, and its own changeset said both were written first.
Neither was. For the time between those merges, roughly 600 lines of the only account of wiring an
MCP tool server and of reading a run's telemetry were reachable from nowhere, behind pointers that
404'd. Both pages now exist, written to the anchors this repo had already committed to. CLAUDE.md's
staleness sweep turns the ordering rule into an action a reviewer can see the absence of: open the
website pull request first, and NAME it in this one's description.

Item 12 is closed by RENDERING rather than moving. `sync-openapi.mjs` on the website emits an API
endpoint reference from `docs/openapi.json`, so the complete operation list stops being something
the site tells a reader to go and fetch. Its reduction half is re-scoped by measurement: the
`## Reference` section is 1,352 lines of which 125 are endpoint-table rows, and the spec collapses
every client failure into one `4XX`, so gutting those tables toward the generated page would delete
the surface's refusal vocabulary. What the generated page does own is stated at the top of the
section.
