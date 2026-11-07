---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

Add the `research` job kind to the executor harness: an agent over a browser and the research
tool server against a vendor, with no checkout of its own (linked services' repos arrive as
read-only reference clones). The research tool server holds the run's credential values and
offers `fill_secret`, `http_request` and `request_credential`; a credential only reaches one of
the definition's target origins, responses are scrubbed before the model sees them, and each HTTP
exchange is recorded as evidence. The tool server runs in the harness process, so no credential
value is ever written to disk or handed to a process the agent can inspect. The browser image gains Playwright MCP (`@playwright/mcp@0.0.84`),
pointed at one per-job Chromium over CDP. Runner image 1.166.0.
