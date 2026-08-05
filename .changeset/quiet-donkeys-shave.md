---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/gates': patch
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Close three holes in `/api/v1` around a run that stops.

- **A bug-triage question is now answerable from the ticket it was asked on.** The clarity gate's
  park echo rendered its findings as bare prose, so the ticket-comment reply grammar (which
  addresses a finding by id) could never reach it. Both review subjects now ride one id-carrying
  post path, and a comment naming a clarity finding drives the clarity review through the same
  service methods the app calls.
- **`decisions: []` no longer means "we cannot say".** The decision list carries `unanswerable[]`,
  naming each wait this surface cannot answer — a human-review gate, a gate the deployment
  registered itself, an interviewer wired nowhere — with where its answer actually lives. It lists
  only waits that are live and genuinely beyond this surface: a finished run names nothing, and a
  wait the same response answers (a deployment gate that exhausted onto an ordinary approval) is
  never reported as one nobody here can answer.
- **`GET /api/v1/me`** reports what the calling key may do, and **`GET /api/v1/openapi.json`**
  serves the deployment's own spec.

Internal break: `IssueWritebackProvider.postQuestions` is gone (folded into `postReviewQuestions`,
which now takes a subject), and `TrackerWebhookService` takes `reviewGateways` per subject in place
of the single `reviewGateway`.
