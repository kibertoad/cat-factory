---
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': patch
---

Initiative presets — slice 6 (docs-refresh pilot): deterministic documentation-layout
autodetection.

- **agents** (`presets/docs-refresh/docs-detect.logic.ts`): a new pure `detectDocsLayout(reader)`
  heuristic — the checkout-free repo probe behind the docs-refresh preset's form prefill (its
  `detect` hook lands in slice 8). Over a narrow `DocsRepoReader` (a `RepoFiles` satisfies it
  structurally) it proposes the preset's placement DEFAULTS without a clone: the docs root
  (`docs`/`doc`/`documentation`), the diagrams + business-rules subfolders (known dir-name
  heuristics under the detected root), a monorepo flag (workspace manifest / `package.json`
  `workspaces` / conventional `packages`|`apps`|`services`|`libs` dirs), a `per-service` vs `root`
  placement decision (sampled from whether most packages carry their own docs), and an
  `hasExistingMermaid` hint for the analyst.
- Deterministic, memoized, bounded by a hard read budget, and TOTAL — it never throws and never
  rejects, so an unwired GitHub / a partial or unreadable repo simply yields the conventional
  defaults (a prefill must never block create). Detected values are non-binding FORM DEFAULTS; a
  user edit wins and the analyst confirms placement at planning time.
- **kernel** (`shared/repo-scan.logic.ts`): extracts the checkout-free scan primitives the repo
  auto-detectors share — `joinRepoPath` + the budgeted, memoized `BudgetedRepoScanner` (over a
  `CheckoutFreeRepoReader`) — into one home, so a fix to path normalization / caching / budget
  lands once instead of drifting across copies.
- **integrations**: the service-provisioning (`provision-detect`) and frontend-config
  (`frontend-detect`) detectors now consume the shared kernel primitive instead of their own
  private `joinPath` + `Scanner` copies — a behaviour-neutral refactor (the shared `exhausted`
  uses the precise "a read was actually skipped" semantics both had converged toward).
