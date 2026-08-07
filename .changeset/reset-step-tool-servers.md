---
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
---

Drop a step's tool-server (MCP) record when it is reset for a re-run.

The record describes one resolution against one harness, one secret resolver and one set of OAuth
grants, so a re-armed step holding the previous dispatch's answer renders chips for a resolution
nothing has made yet, and for servers a deployment may since have retired. A container re-dispatch
rewrote it in any case; what this closes is the gap where nothing does, which is a step sitting
`pending` after the reset, one re-dispatched inline (whose handle carries no resolution), and one
whose run is abandoned before it redispatches.

This widens what an ABSENT `step.toolServers` means, so the documented rule moves with it. Absent
now means the step's CURRENT attempt holds no resolution: an inline step, a run predating the
field, or a step re-armed and not yet re-dispatched. The distinction the rule exists for is
untouched (a step that lost every server it declared still never reads as one that declared none),
but absent no longer implies the step never ran, and `attempts`/`dispatches` outlive the reset
precisely so that question keeps an answer. The field was already optional on the wire and on
`/api/v1/debug/*`, so no consumer sees a shape it was not already required to tolerate.

The other fields `recordDispatchAttribution` pins are deliberately left alone, and the reason is
in the comment: `model`, `subscriptionTokenId` and `initiatedByUserId` are read back when the job's
usage lands, so clearing them would put every re-run's `token_usage` row back to provider
"unknown". `skillVersions` and `promptRevision` need nothing, being assigned unconditionally at
dispatch.
