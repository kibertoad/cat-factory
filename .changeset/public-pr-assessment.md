---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': patch
---

`POST /api/v1/pr-assessments` (`client.prAssessments.assess`) scores a pull request in a linked
repository on the merger's complexity, risk and impact axes, classifies it by its changed paths, and
says whether a risk policy would let it land with no person: the named policy, or the workspace's
unattended default. The verdict comes from the merge step's own precedence ladder, now a pure
function shared by both (`mergePrecedence.ts`), so the policy's ceilings stay unpublished. A key bound to a person is judged under that person's
workspace role, as the runs it starts are. One
synchronous inline model call at `write` scope; nothing is persisted. OpenAPI 1.83.0.
