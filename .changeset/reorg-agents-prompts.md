---
'@cat-factory/agents': patch
---

Reorganize the `agents/` source into focused subfolders so each agent's prompt is
easy to find. Pure internal refactor: the package's public barrel exports are
unchanged, the precompiled template output is byte-identical, and behaviour is the
same. The prompt TEXT now lives under `agents/prompts/*` (one file per track:
`standard`, `acceptance`, `business-logic`, `mock`, `testing`, `companion`,
`requirements`, plus the thin `roles` map extracted from the old `agent-catalog`,
and the shared `shared`/`delivery-contract` constants); metadata ABOUT kinds lives
under `agents/kinds/*` (`companions`, `traits`, `configs`, `read-only`, `registry`,
`versions`); the model-call machinery lives under `agents/runtime/*` (`executor`,
`routing`, `fragments`, `web-search`); and `agents/catalog.ts` is the dispatcher
that maps a kind to its prompt. The versioned-prompt registry (`versions`) is split
from the requirements prompt text (`prompts/requirements`) it references.
