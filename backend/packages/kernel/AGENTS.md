# `@cat-factory/kernel` — shared vocabulary + ports

The dependency **leaf** of the domain (depends only on `@cat-factory/contracts`). Everything
else imports its **ports** and domain types from here.

**Entry:** `src/index.ts`.

**Where things live:**

- `ports/` — **all ~84 repository/port interfaces**: the hexagonal seam every runtime facade
  implements. Adding a persisted table or a gateway starts with a port here (then a D1 repo +
  a Drizzle repo — see "Keep the runtimes symmetric").
- `domain/` — domain types (`types.ts`, re-exporting contracts), pure logic + constants
  (`seed.ts`, `catalog.ts`, `models.ts`, `subtasks.logic.ts`), and the **public extension
  registries**: `gate-registry.ts` + `gate-logic.ts`, `pipeline-registry.ts`,
  `provider-registry.ts`, `vcs-registry.ts`, `step-resolver-registry.ts`,
  `service-registration.ts`. The `registerGate`/`registerPipeline`/`registerAgentKind`/
  `registerVcsProvider` seams live here — a gate/agent package never depends on orchestration.
- `shared/` — `*.logic.ts` pure helpers, incl. the checkout-free repo-scan primitives
  (`repo-scan.logic.ts` — `BudgetedRepoScanner`) and the **manifest-probe** toolkit for
  custom-provider autodetection (`manifest-probe.logic.ts` — `matchManifestSignature`,
  `firstPresent`/`allPresent`, `readYamlDoc`, `listFiles`, + the `CustomManifestDetection` /
  `CustomManifestDetectionContext` authoring types).

**See also:** `CLAUDE.md` → "Gates vs agents (the step taxonomy)", "Custom agents".
