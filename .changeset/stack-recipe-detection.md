---
'@cat-factory/integrations': minor
---

feat(environments): stack-recipe detection (shared-stacks initiative, slice 2)

Extend the deterministic, checkout-free provisioning detector (`provision-detect.logic.ts`) to
recognize the STACK RECIPE a complex `docker-compose` repo implies (the lokalise-main pilot),
populating the recommendation shape slice 1 added. Still non-binding — nothing is applied beyond
the pre-selected base layers; the wizard (slice 7) confirms.

- **Compose-file layering** — a bare `dev.yml` base is now recognized, and a base file's
  `<stem>.override.ya?ml` auto-merge sibling is layered into `recipe.composeFiles` while
  OS-specific overrides (`dev.wsl.override.yml`, `dev.mac.override.yml`) are surfaced as opt-in
  `composeFileCandidates` annotated with `os` (never auto-layered).
- **External networks** — a top-level `networks:` entry flagged `external: true`
  (or `external: { name }`) → `recipe.externalNetworks` + a nudge to bind it to a shared stack
  (no `sharedStackRefs` fabricated — stacks arrive in slice 4).
- **Env-file materialization** — committed `*-dist` / `*.example` / `*.dist` config templates
  beside the compose file / in the service's config dirs → `recipe.envFiles` template→target pairs
  (`.env.dev.local-dist` → `.env.dev.local`, `.split.yaml.dist` → `.split.yaml`); non-config
  templates like `README.dist` are ignored.
- **Profiles** — the union of services' `profiles:` labels → default-off `profileCandidates`
  (opt-in groups; never written into `recipe.composeProfiles`).
- **Seed dumps** — `*.sql` under seed-ish dirs (`deployment/`, `seed/`, …, one level deep) →
  low-confidence `seedDumpCandidates`, fullest-dump pre-selected, wizard-confirmed into a seed step.
- **Repo-CLI hint** — a `bin/*console*` CLI / `Makefile` / `justfile` / `Taskfile` → the report-only
  `repoCliHint` (the nudge toward the slice-8 environment analyst). Detection never parses shell.

The compose-doc semantics (`extractExternalNetworks`, `extractComposeProfiles`) live in
`compose-environment.logic.ts` so the compose provider (slice 5) reuses the same predicates. When a
repo is not recipe-shaped, the recommendation is byte-for-byte the simple single-file output as
before. Fixture-driven unit tests cover each extension plus a combined lokalise-main-shaped repo.
