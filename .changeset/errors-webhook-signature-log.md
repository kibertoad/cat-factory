---
'@cat-factory/server': patch
---

Log an elaborate operator remedy when a webhook delivery is rejected for a bad signature
(error-message initiative C2). Both receivers — GitHub's `/github/webhooks` (HMAC over the raw
body via `X-Hub-Signature-256`) and the neutral `/vcs/:provider/webhooks` (GitLab's
`X-Gitlab-Token`) — keep returning the deliberately terse `401 Invalid signature` to the external
caller, but now emit one structured `logger.warn` naming the likely setup mistake and exactly
where to fix it. The shared `describeWebhookSignatureRejection` (`server/src/webhooks/signatureLog.ts`,
unit-tested) tailors the message to the sub-case — no deployment secret configured (`*_WEBHOOK_SECRET`
unset), no signature header present (the provider-side secret isn't set), or a mismatched
signature (the two secrets differ) — and links `docs/github-integration.md#authentication` /
`docs/vcs-providers.md#setup`. It carries no secret material, only env-var names and the
provider settings field to compare against.
