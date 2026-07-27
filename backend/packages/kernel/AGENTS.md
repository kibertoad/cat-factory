# `@cat-factory/kernel` — shared vocabulary + ports

The dependency **leaf** of the domain (depends only on `@cat-factory/contracts`). Everything
else imports its **ports** and domain types from here.

**Entry:** `src/index.ts`.

**Where things live:**

- `ports/` — **all ~84 repository/port interfaces**: the hexagonal seam every runtime facade
  implements. Adding a persisted table or a gateway starts with a port here (then a D1 repo +
  a Drizzle repo — see "Keep the runtimes symmetric"). `ports/repo-files.ts`'s `RunRepoContext`
  carries the run repo's provider-neutral identity (`repoId` + `provider`) alongside the bound
  `RepoFiles`, so a caller that resolved a run's repo can RECORD which repo it was and later
  correlate an inbound webhook — which names a repository by exactly that id.
- `domain/` — domain types (`types.ts`, re-exporting contracts), pure logic + constants
  (`seed.ts`, `catalog.ts`, `models.ts`, `subtasks.logic.ts`, `change-class.ts` — the
  deterministic changed-file → change-class classifier + its risk ranking and the per-class
  merge-rule resolution), and the **public extension
  registries**: `gate-registry.ts` + `gate-logic.ts`, `pipeline-registry.ts`,
  `provider-registry.ts`, `vcs-registry.ts`, `step-resolver-registry.ts`,
  `service-registration.ts`. The `registerGate`/`registerPipeline`/`registerAgentKind`/
  `registerVcsProvider` seams live here — a gate/agent package never depends on orchestration.
- `domain/pr-report.ts` — the marker-delimited `spliceManagedSection` / `readManagedSection`
  behind the engine's **PR verification report** (the pure half; the `PrVerificationReportPublisher`
  port is in `ports/pr-report.ts`, the composer in orchestration).
- `shared/` — `*.logic.ts` pure helpers, incl. the checkout-free repo-scan primitives
  (`repo-scan.logic.ts` — `BudgetedRepoScanner`) and the **manifest-probe** toolkit for
  custom-provider autodetection (`manifest-probe.logic.ts` — `matchManifestSignature`,
  `firstPresent`/`allPresent`, `readYamlDoc`, `listFiles`, + the `CustomManifestDetection` /
  `CustomManifestDetectionContext` authoring types).

**See also:** `CLAUDE.md` → "Gates vs agents (the step taxonomy)", "Custom agents",
"Merge track record".
