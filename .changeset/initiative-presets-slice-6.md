---
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
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
  `CheckoutFreeRepoReader`) — into one home, so `detectDocsLayout` reuses them instead of adding a
  third private copy. The environments detectors (`provision-detect` / `frontend-detect`) still
  carry their own copies and should converge onto this in a follow-up.
