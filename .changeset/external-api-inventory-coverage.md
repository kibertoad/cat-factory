---
---

Repo tooling only: close the coverage holes in the `check-external-api-inventory` guard that made
its "all classified" line weaker than it read. The detector now catches a call through a locally
bound transport alias (`const doFetch = deps.fetch ?? fetch`), which was hiding OpenRouter, the
hand-rolled OIDC/SSO client, the MCP probe and a GitHub call carrying the pinned API version; a
second direction catches a vendor endpoint we DECLARE for something else to send, which is how a
hand-written Gemini image contract sat outside the inventory entirely. Ten more vendors are now
swept, a `vendor` entry's files have to support the vendors it claims (so a directory-wide row can
fail), and `--list` emits the attribution the sweep's record table needs instead of bare paths.
