---
'@cat-factory/app': patch
---

Add stable `data-testid` hooks to the agent-failure banner + retry (`AgentFailureCard`), the
bootstrap progress badge (`BlockNode`), and the inspector step rows + subtask bars
(`TaskExecution`), so the e2e suite can assert on the failure/retry, bootstrap, merge-review
and async-progress live flows. Behaviour-neutral markup only.
