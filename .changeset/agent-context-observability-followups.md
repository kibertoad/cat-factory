---
"@cat-factory/server": patch
"@cat-factory/worker": patch
---

Two follow-ups to the agent-context observability feature:

- **Worker:** the daily retention `scheduled` handler now fails fast with the same clear
  "TELEMETRY_DB binding is required" error as the request-path container build (via a
  shared `requireTelemetryDb` helper) instead of producing an opaque NPE deep in a
  telemetry repo when the binding is unbound.
- **Server:** the agent-context snapshot now strips any embedded `user:pass@` userinfo
  from the stored injected-doc URLs and the tester's ephemeral `environmentUrl`, upholding
  the allow-list's "never a credential-bearing URL" promise even when an operator's
  environment-provider mapping populates a credentialed URL.
