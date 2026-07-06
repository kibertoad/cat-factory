# Stack-recipes pilot fixtures & goldens (slice 9)

Durable pilot for the [`stack-recipes-and-shared-stacks`](../../../../../../../../docs/initiatives/stack-recipes-and-shared-stacks.md)
initiative. These are a **sanitized, reduced snapshot** of the initiative's two acceptance
repos — a complex consumer monolith (`consumer-main/`) and its sibling shared-infra stack
(`shared-services/`) — plus the **golden** detector output for each and the **reference**
recipe / shared-stack configs the pilot targets.

> **Sanitization policy.** Nothing here names any real upstream repo, product, host,
> registry account, or secret. Service keys, network names, and paths are the generic
> `acme-*` placeholders the initiative tracker uses throughout. The env-template file
> carries only placeholder values. Do not reintroduce upstream-specific strings.

## Layout

| Path                                 | What it is                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consumer-main/`                     | The complex consumer's provisioning surface: `docker/dev.yml` (28 services) + OS overrides, an external network, profiles, seed dumps, a repo CLI, and a root `catalog-info.yaml`. |
| `shared-services/`                   | The shared stack's `docker-compose.yml` (17 services), its `acme-net` external network, `backends`/`peer` profiles, and the `.env.shared.example` template.                        |
| `consumer-main.detect.golden.json`   | The full `docker-compose` `ProvisioningRecommendation` the detector produces for `consumer-main/`.                                                                                 |
| `shared-services.detect.golden.json` | The full `SharedStackRecommendation` the detector produces for `shared-services/`.                                                                                                 |
| `reference/consumer-recipe.json`     | The hand-authored target `StackRecipe` a saved provisioning config would hold (the mapping table's A-rows + M-row preflights).                                                     |
| `reference/shared-stack.json`        | The hand-authored target `CreateSharedStackInput` (the public `backends` subset, network + preflights + setup steps).                                                              |

## Why these are reduced

The fixtures contain only the facts the **deterministic detector** reads: `services:` keys
(in the repos' real declaration order), external networks, `profiles:`, `build:` directives,
env/config templates, seed `*.sql` dumps, and the repo-CLI presence. Real images, env
blocks, ports, volumes, and healthchecks are omitted — the detector never reads them, and
leaving them out keeps upstream detail (and secrets) out of the tree. Despite the reduction,
the fixtures reproduce the sanitized live detection **byte-for-byte** (see the drift alarm),
so the goldens are a faithful record of the pilot's shape.

## Golden test

[`../../pilot-golden.logic.test.ts`](../../pilot-golden.logic.test.ts) reads each fixture
directory over a filesystem `ProvisioningRepoReader` (the same port the GitHub/GitLab reader
implements) and asserts the detector output equals the committed golden, plus that the
`reference/` configs are schema-valid and wired together (the consumer's `sharedStackRefs`
names the shared stack; its seed step imports a dump that exists; the shared stack owns the
network the consumer attaches to). It runs everywhere (`pnpm test:run`, incl. Windows) — no
clone, network, or Docker needed.

## Refreshing goldens & the upstream-drift alarm

[`scripts/pilot-detect-golden.mjs`](../../../../../scripts/pilot-detect-golden.mjs)
(`pnpm --filter @cat-factory/integrations pilot:golden`) regenerates or diffs the goldens.
It requires a build first (`pnpm --filter @cat-factory/integrations build`).

- **After an intentional detector or fixture change** — regenerate and commit:
  ```
  pnpm --filter @cat-factory/integrations build
  node scripts/pilot-detect-golden.mjs --write
  ```
- **Upstream-drift check** — point it at live clones and diff. A live repo carries upstream
  names, so supply a sanitize map (a JSON array of `{"from","to"}`) via `PILOT_SANITIZE_MAP`
  or a gitignored `scripts/pilot-sanitize.local.json` (never committed — it names the real
  repo). Drift here means the upstream repo's shape changed; update the fixtures to match.
  ```
  ACME_MONOLITH_DIR=/path/to/consumer \
  ACME_SHARED_SERVICES_DIR=/path/to/shared \
  PILOT_SANITIZE_MAP='[{"from":"<upstream>","to":"acme"}]' \
  node scripts/pilot-detect-golden.mjs --check
  ```

## Known artifacts & limitations (faithful, documented)

- **The consumer's `catalog-info.yaml`** parses as a `kind` + `apiVersion` document, so the
  detector's k8s scan counts the repo root as a raw-manifest location and the compose
  recommendation carries a low-confidence "Kubernetes manifests also exist" note. That is an
  incidental artifact of the real repo shape, reproduced on purpose; if the detector later
  stops treating a Backstage catalog as a manifest, the golden test flags it (correct drift).
- **Env templates one level into monorepo service dirs ARE detected.** The real consumer keeps its
  `*-dist` templates under `services/app/` (outside the compose dir). The detector scans the compose
  dir + the root config dirs AND one level into the monorepo container dirs (`services/*`, `apps/*`,
  `packages/*`), so those templates are surfaced — the consumer golden carries `recipe.envFiles` for
  `services/app/.env.dev.local-dist` + `.split.yaml.dist`. A template nested deeper than one level, or
  under a non-standard container dir, still isn't seen by the deterministic scan — set
  `ENVIRONMENTS_DETECTION_CONVENTIONS.envTemplateDirs` (deployment config) or lean on the environment
  analyst for those.
