# Documentation revamp: the repo ⇄ website split

Status: **executing; items 12 and 16 are what is left.** The 2026-08-09 revision found the
remaining scope bigger than the checklist read, and the phase that followed closed most of it: item
17 decided manifest ownership, the website's phase E landed the four destinations that decision and
the audit's repo-only row were waiting on, every one of the ten pointerless docs gained its pointer,
the three reductions blocked on a missing page ran, and items 16 and 18 turned the whole
markdown-link class from unguarded into CI-enforced in both repositories.

What is open, and neither is blocked on anything:

- **Item 12**, rendering the `/api/v1` reference from `docs/openapi.json` onto the site, on the
  `sync-env-vars.mjs` machinery both repos already trust.
- **Item 16's follow-on judgement**: the guard is green and the twelve dangling links are fixed, but
  the CHANGELOG exclusion is a decision recorded in code rather than one anybody has revisited.

The sibling tracker is
[`planning/documentation-revamp.md`](https://github.com/kibertoad/cat-factory-website/blob/main/planning/documentation-revamp.md)
in the website repo, reopened with a phase E for the four destinations it owed.

## Goal and rationale

The platform has two documentation surfaces: this repo (the root `README.md`, `backend/docs/`,
`docs/`, package `README`s, `sdk/`) and the product site
[catfactory.ai](https://www.catfactory.ai/) (repo
[kibertoad/cat-factory-website](https://github.com/kibertoad/cat-factory-website)). No stated
rule decides which surface owns a topic, so three problems have accumulated:

- **Most large topics are documented twice**, once per surface, each pair drifting independently:
  custom agents, the public API, model support, runner pools, ephemeral environments, the GitHub
  App, environment variables, the glossary, the agent trust model, storage and retention, and the
  repository layout. The audit below pairs each with its live website page.
- **Some user-facing material is repo-only.** As written: `backend/docs/vcs-providers.md`,
  `backend/docs/debug-api.md`, `backend/docs/reports.md`, `sdk/README.md` and `sdk/mcp/README.md`
  serve integrators and operators, none of whom should need a checkout to read them, and the site's
  navigation carried no page for any of them. Slices 7 and 9 closed three, and the last two were
  resolved by pointing at pages that already served their readers. The class did not close with
  them: `auth.md`, `reusable-operations.md` and `figma-claude-design-context.md` are repo-only
  today, and the first of those is the enterprise sign-in path.
- **The root README restates the website.** Its Feature guide and parts of the Documentation
  index duplicate the site's guide section instead of pointing at it.

The revamp is one conceptual model that assigns every doc a home, executed incrementally with
a per-slice checklist.

## The conceptual model

Ownership follows the READER, not the topic.

- **The website is for people who run and use the product**: deployers, operators, workspace
  users, and integrators building on the public surface (API, SDKs, MCP, manifests). The
  test: the reader can act on the page without cloning this repo.
- **The repo is for people who change the code**: flow docs, ADRs, initiative trackers,
  `AGENTS.md` maps, package `README`s, the CI/test/release process, `CLAUDE.md`. The test:
  the doc is updated in the same PR as the code it describes, or it describes this
  repository's own process.

This is the standard split among mature projects. React keeps react.dev as the product docs
while facebook/react holds only contributor material; Kubernetes splits kubernetes.io from
kubernetes/kubernetes, with contributor docs in kubernetes/community; Node.js, Vue and Vite
publish user docs on their sites and keep the repo for contributors. The section-structure
research (Diátaxis, the Kubernetes/GitLab/Stripe navigation models) lives in the website
tracker, which applies it.

Five rules follow:

1. **One authority per topic.** Where a topic serves both audiences, split by DEPTH, never by
   copy: the website page owns the user-facing account, and the repo doc keeps only the
   internal design plus a link to the website page for usage. Two parallel full accounts is
   the failure mode this model exists to end.
2. **A repo gap links the website section.** Where a repo doc needs user-level context (how a
   feature is operated, what a screen shows), it links the relevant website section instead
   of restating it. The root README's Cookbook entry ("product docs, task-indexed rather than
   architecture-indexed") already does this; it is the model to copy.
3. **A website gap is filled by moving, never mirroring.** Where the website lacks material
   that exists here, the user-facing content moves there and the repo keeps a pointer plus
   whatever internal depth remains.
4. **Named exceptions stay in the repo regardless of audience**:
   - package `README`s that ship in published tarballs (`check-shipped-doc-links.mjs` bans
     out-of-package links, so they stay self-contained; they may link the website by absolute
     URL);
   - generated reference (`docs/openapi.json`) that the site renders or links rather than
     recreates;
   - GitHub-native surfaces: `CONTRIBUTING.md`, and the README quickstart kept short with the
     site as the long version;
   - **a doc a CI guard reads**, which stays where the guard runs (see the
     `check-reserved-env-keys.mjs` and `check-package-catalog.mjs` gotchas): the guard's value is
     that it fires in the PR that changes the code, so the doc has to live in that PR's repo.
5. **The staleness sweep covers the website.** The per-PR documentation sweep (CLAUDE.md)
   gains one question: does this change alter behaviour a website page describes? If yes, the
   PR says so, and the website repo's `sync-docs` pass (which reads this repo's commit
   history) picks it up.

## Current duplication and misplacement

The audit so far, re-checked against the site's live navigation on 2026-08-09 and to be completed by
slice 1. **Assume the website already covers a topic until its navigation says otherwise**: the
first draft of this table recorded "none" for four topics the site already documents, which scoped
their slices as moves into a gap rather than as the reconciliations they are. Website cells name
the source path in the website repo, **re-checked after that repo's phases C and D**, which moved
the extension pages under `extend/` and the operating pages under `operate/` and split two pages in
half. A cell here is the first thing the next slice reads, so a path left at where the page used to
be is the rot this table exists to prevent.

**A "none" cell rots in one direction and it is the expensive one.** A slice that lands a website
page does not come back to unset it, so the row keeps claiming a gap that has been filled and the
next slice re-scopes the topic as a move rather than a reconciliation: the exact mistake the first
draft made, re-made. Three of the original "no website page today" entries had gained pages by
slices 7 and 9 and are now their own rows. So the "none" row is re-read against the live navigation
on every audit pass, and a slice that lands a page moves its topic out of it in the same PR.

**A path in the Website cell records EXISTENCE, and the reductions keep discovering that existence is
not coverage.** Two of the three cuts attempted so far found the named page stopping above the depth
the repo doc carries, which is the third duplication class the [reduction findings](#what-a-reduction-actually-turns-up)
section now names. Where a slice has established the answer, the cell says `owns` or `overview only`,
so the next slice reads the depth verdict rather than re-deriving it from a page that looks like the
senior partner because it has more sections.

| Topic                            | Repo doc                                                                                          | Website page                                                                | Proposed authority                                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom agents                    | `backend/docs/custom-agents.md`, `custom-agent-roles.md`, `custom-agent-gate-ergonomics.md`       | `extend/custom-agents.md`, `extend/custom-gates.md`                         | Website owns authoring how-to; repo keeps engine design (registries, the three stages). All three now open with a pointer.                                                                                                                                                                      |
| Public API                       | `backend/docs/public-api.md`                                                                      | `extend/public-api.md`                                                      | Website owns endpoint/scope/webhook usage; repo keeps the stability policy (ADR 0034) and the contracts → spec → SDK chain.                                                                                                                                                                     |
| Model support                    | `backend/docs/model-support.md`                                                                   | `guide/model-providers.md`                                                  | Website owns configuration and usage; repo keeps provisioning internals. Pilot slice.                                                                                                                                                                                                           |
| Runner pools                     | `backend/docs/runner-pool-integration.md`                                                         | `operate/runner-pools.md`                                                   | Website owns operating a pool; repo keeps the integration protocol.                                                                                                                                                                                                                             |
| Environments                     | `backend/docs/environments-integration.md`, `local-k3s-environments.md`, `kubernetes-topology.md` | `operate/environments.md`, `deploy/kubernetes.md`, `extend/manifests.md`    | Website owns setup and operation; repo keeps provider integration design. Reduced in slice 15b, with ONE exception the site must close first: `extend/manifests.md` stops above the field level, so the environment manifest's schema, worked example and variable tables stay in the repo doc. |
| GitHub App                       | `backend/docs/github-integration.md`, `github-operations.md`                                      | `deploy/github-app.md`                                                      | Website owns setup and the operations runbook; repo keeps integration design.                                                                                                                                                                                                                   |
| Environment variables            | `docs/environment-variables.md`                                                                   | `reference/environment-variables.md` (GENERATED), `deploy/configuration.md` | The repo file is canonical: `check-reserved-env-keys.mjs` reads it and the site RENDERS it into the reference page, so that page is the one item 3's `--check` guards. `deploy/configuration.md` narrates by hand the subset an operator sets, and links the generated page for the rest.       |
| Glossary                         | `docs/glossary.md`                                                                                | `reference/glossary.md`, `guide/core-concepts.md`                           | Website owns the product vocabulary; the repo glossary keeps the code-level naming map (dir ⇄ package names, internal seams).                                                                                                                                                                   |
| Agent trust model                | `backend/docs/security-model.md`                                                                  | `reference/agent-isolation.md`, `reference/security-model.md`               | Website owns the operator-facing account of what an adversarial agent can reach; repo keeps the full layer-by-layer boundary and the write-path rules.                                                                                                                                          |
| Storage and retention            | `backend/docs/storage-and-retention.md`, `llm-telemetry.md`                                       | `operate/observability.md`, `operate/upgrades-and-retention.md`             | Website owns retention windows and what is kept; repo keeps the table/rollup design.                                                                                                                                                                                                            |
| Repository layout                | root `README.md` tables                                                                           | `reference/packages.md`                                                     | Website owns the orientation map; the repo tables stay, pinned by `check-package-catalog.mjs`.                                                                                                                                                                                                  |
| VCS support                      | `backend/docs/vcs-providers.md`, `gitlab-parity.md`                                               | `reference/vcs-support-matrix.md`                                           | Website owns the parity matrix and provider setup; repo keeps the provider-layer map and the accepted-gap log. Landed in slice 9.                                                                                                                                                               |
| SDKs and MCP                     | `sdk/README.md`, `sdk/mcp/README.md`                                                              | `extend/sdks.md`, `extend/mcp-server.md`                                    | Website owns consuming a client; the READMEs keep the generation chain, the smoketest and releases. Landed in slice 7.                                                                                                                                                                          |
| Integration manifests (BOTH)     | `runner-pool-integration.md` §3, `environments-integration.md` "The manifest"                     | `extend/manifests.md` (OWNS the format)                                     | DECIDED (item 17, outcome a): the website owns the field level for both manifests, and the shared auth-scheme table is stated there ONCE rather than per manifest. Both repo sections reduced to a pointer plus what a change HERE has to keep true (the Valibot schema's location, the derivation of `{{input.*}}`). |
| Debug API and reports            | `backend/docs/debug-api.md`, `backend/docs/reports.md`                                            | `extend/public-api.md`, `operate/observability.md`                          | Resolved without new pages: both readers were already served, so each doc points at the page that owns its reader and keeps the design. Was a "none" row; this is the rot the paragraph above describes, caught on the 2026-08-09 re-check.                                                     |
| Enterprise SSO                   | `backend/docs/auth.md`                                                                            | `deploy/sso.md` (owns setup + admission)                                    | CLOSED. Was the sharpest repo-only row: the site named three sign-in providers and never mentioned OIDC. The page owns registering the application, the nine variables, the four boot refusals and the directory-as-allowlist model; the doc keeps the legs, what each verifies, and revocation.  |
| Reusable operations              | `backend/docs/reusable-operations.md`                                                             | `extend/reusable-operations.md`                                             | CLOSED. The reader is a deployment author writing their own package against published seams, which is the Extend audience. The doc keeps the engine side: no `switch(taskType)`, the fold's three emit points, the drift guards, the mothership position.                                        |
| Design context                   | `backend/docs/figma-claude-design-context.md`                                                     | `guide/design-context.md`                                                   | CLOSED. Was a tip box on `guide/issue-sources.md`. The page owns connecting a source, what the agent receives, what each cap asks the reader to DO, and the freshness verdicts; the doc keeps the source-neutral model and the ladder's cost model.                                              |
| Repo-only, no website page today | none                                                                                              | n/a                                                                         | Empty for the first time since this table was written. Re-derive it, rather than trusting this cell, on the next audit pass: it is the row the "a `none` cell rots in one direction" note above is about, and an empty one rots the same way.                                                    |

## Classification (slice 1)

Every doc under `backend/docs/` and `docs/`, classified by READER. "Mixed" means the topic serves
both audiences and is split by depth: the website page owns the user-facing account and the doc here
keeps the internal design plus a link.

Rather than one row per file, whole categories classify together and only the exceptions are named,
because a per-file table of 160 rows rots faster than the docs it describes.

| Category                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Classification       | Rule                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/docs/adr/*` (50 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | contributor          | A decision record is written for whoever changes the code next. None moves.                                                                                                                               |
| `docs/initiatives/*` (64 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | contributor          | Describes a target state that may be partly built. Never a user-facing source.                                                                                                                            |
| `docs/internal/*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | contributor          | This repository's own process.                                                                                                                                                                            |
| Engine flow docs: `agent-prompt-overrides`, `bug-hunt`, `bug-triage-pipeline`, `concurrency-and-redis`, `consensus-panels`, `container-reaping`, `env-lifecycle`, `execution-state-machine`, `gitlab-parity`, `individual-subscription-usage`, `infrastructure-providers-window`, `logging`, `per-service-provisioning`, `pipeline-catalog-lifecycle`, `pipeline-pr-descriptions`, `prompt-caching`, `ralph-loop`, `requirements-review`, `review-debt-friction`, `service-connections`, `visual-confirmation`                   | contributor          | Each describes a seam, an invariant or a flow the code implements. The product behaviour they produce is described on the website by the page that owns that feature, and none of these is that page.     |
| `model-support`, `security-model`, `storage-and-retention`, `llm-telemetry`, `custom-agents`, `custom-agent-roles`, `custom-agent-gate-ergonomics`, `mcp-tool-servers`, `custom-binary-stores`, `github-integration`, `github-operations`, `vcs-providers`, `environments-integration`, `local-k3s-environments`, `native-environment-adapter`, `kubernetes-topology`, `runner-pool-integration`, `document-sources`, `auth`, `reports`, `debug-api`, `reusable-operations`, `initiative-presets`, `figma-claude-design-context` | mixed                | Split by depth. All 24 now open with a pointer naming the website page that owns the user-facing account, and the reduction has run on twelve. Per-doc state: item 15's inventory.                        |
| `docs/environment-variables.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | user-facing, stays   | A CI guard reads it. The website RENDERS it.                                                                                                                                                              |
| `docs/glossary.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | contributor          | Code-level naming map; the product vocabulary is the website's glossary.                                                                                                                                  |
| `docs/README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | contributor          | This repository's own orientation and process.                                                                                                                                                            |
| `backend/docs/public-api.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | mixed, deferred      | See checklist item 12.                                                                                                                                                                                    |
| `backend/docs/local-kubernetes-setup-windows.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | user-facing, unmoved | A platform-specific setup recipe with no website home yet. Candidate for the Deploy section; not worth a page of its own until the Kubernetes page needs it.                                              |
| `sdk/README.md`, `sdk/mcp/README.md`, `sdk/*/README.md`, `backend/packages/*/README.md`, `deploy/*/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                    | named exception      | A README that ships in a published tarball stays self-contained and links the website by absolute URL.                                                                                                    |
| `docs/openapi.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | named exception      | Generated. The site links or renders it, never recreates it.                                                                                                                                              |

Two classifications changed as the slices ran, and both are recorded because the reasoning is not
obvious from the file:

- **`gitlab-parity.md` is contributor**, even though the support matrix it feeds is user-facing. The
  matrix says what a user gets; the parity log says which gaps are deliberate and which are pinned
  by a conformance suite, which only means something with the code open.
- **`github-operations.md` is mixed rather than user-facing.** Setup moved, but the failure
  signatures and the token plumbing are read with the repository open.

## Target pattern (the pilot)

Pilot topic: **model support**, because the pair is large, actively edited, and cleanly
splittable.

- `guide/model-providers.md` on the website absorbs everything user-facing that today only
  `backend/docs/model-support.md` states.
- `backend/docs/model-support.md` drops the usage sections, keeps the
  provisioning/composition internals, and opens with a link to the website page.
- The root README's Documentation index entry keeps pointing at the repo doc, renamed to say
  it is internals.

The pilot establishes the reusable mechanics: the link phrasing, how much depth stays behind,
and the landing order (website PR first, so the repo link never 404s).

## Checklist

Each slice is a repo PR, a website PR, or a coordinated pair. Update with PR links as slices land.

- [x] 0. Trackers land: [#1847](https://github.com/kibertoad/cat-factory/pull/1847) and the website
      sibling [cat-factory-website#22](https://github.com/kibertoad/cat-factory-website/pull/22).
      This tracker's header now links the website file's permalink rather than its PR.
- [x] 1. Classify every doc under `backend/docs/` and `docs/` (see the classification below).
- [x] 2. Pilot: model support. The website absorbed usage; the repo doc opens with the pointer and
      keeps resolution, precedence, harness and provisioning internals. **Section numbering is
      load-bearing**: `agents/src/providers/docs.ts` links `#8-provisioning-per-runtime` and
      `#aws-bedrock-opt-in` from runtime error messages, so sections may be reduced but not
      renumbered.
- [x] 3. Environment variables. The repo file stays canonical (`check-reserved-env-keys.mjs` reads
      it) and the website page is GENERATED from it by the site's `scripts/sync-env-vars.mjs`, with
      `--check` failing on staleness. Two variables the code reads were documented nowhere
      (`NOTIFICATION_RETENTION_DAYS`, `PROVISIONING_LOG_RETENTION_DAYS`): documenting them required
      reserving them, so `reserved-env-keys.ts` gained both as exact names.
- [x] 4. Agent trust model. The website gained a security-model page (layer taxonomy, the
      non-boundaries, the hardening checklist, the known gaps) beside agent-isolation; the repo doc
      keeps the layer-by-layer mechanism and the couplings a contributor must not break.
- [x] 5. Glossary. The website gained a product glossary; the repo glossary states that it is the
      code-level naming map and what belongs where.
- [x] 6. Storage and retention. The website's upgrades-and-retention page owns the windows and the
      upgrade path; the repo docs keep the sink and rollup design. The site's observability page
      claimed a 3-day telemetry default the code had moved to 14; fixed.
- [x] 7. SDKs and MCP. Two website pages (SDKs, MCP server); `sdk/README.md` reduced to the
      generation chain, the smoketest and releases. The four shipped clients' anchored links to its
      "pointing at localhost" section were repointed at the website page in the same change, per the
      gotcha below.
- [x] 8. Custom agents, gates, providers, frontend extensions. Website owns authoring and the repo
      docs open with the pointer. The reduction `custom-agents.md` still owed landed under item 15a.
      `custom-binary-stores.md` (added after this tracker was written) landed its user-facing half
      on the website's custom-providers page as a third code seam.
- [x] 9. VCS. The support matrix moved to the website; `vcs-providers.md` is now the provider-layer
      map plus the two facts that bite a change, and `gitlab-parity.md` stays the accepted-gap log.
- [x] 10. Root README: the Feature guide is a "using it / how it is built" table, and the
      Documentation index states the ownership model.
- [x] 11. State the model: `docs/README.md` and `CONTRIBUTING.md` gained "Where does a new doc go?",
      and CLAUDE.md's staleness sweep gained the website question (paid for inside the file's size
      budget, not by raising it).
- [ ] 12. **The `/api/v1` endpoint reference stays in the repo, and the slice that moves it is the
      WRONG slice.** `public-api.md` is 2029 lines of prose companion to the generated
      `docs/openapi.json`, and several of its anchors are linked from published package READMEs and
      from error messages in code. The deferral held, but "move 2000 lines of prose" was never the
      shape of the answer: the site already owns the integrator's first read (`extend/public-api.md`),
      and the complete, always-current endpoint reference is the SPEC, which the site today only
      tells the reader to fetch from this repo. So the work is to RENDER it, on the one piece of
      machinery both repos already trust: a `sync-openapi.mjs` beside `sync-env-vars.mjs`, emitting a
      generated reference page from `docs/openapi.json` with a `--check` that fails on staleness.
      That leaves `public-api.md` as the stability policy plus the contracts → spec → SDK chain,
      which is what its classification says it is. The anchor inventory is still the first step,
      because the four inbound shipped-README links decide which headings survive the reduction.
- [x] 14. Enforce the coupling slice 9 broke silently. `scripts/check-doc-anchors.mjs` resolves
      every doc URL built in code to a file AND a heading, across all THREE modules that build them
      (`config/docs.ts`, `vcs-errors.ts`, `providers/docs.ts`: each layer sits below the last and
      cannot import it). Deliberately NOT guarded: whether a catfactory.ai link resolves. That needs
      either the network, which fails on the website's outages rather than on our mistakes, or a
      checked-in copy of the site's page list, which is a second routing table to keep in step and
      rots in the direction that matters most, since a page deleted from the site would stay listed
      and keep passing.
- [x] 15. **Finish the reductions the pointers only announced.** A pointer at the top of a doc is
      not the split; it is the promise of one, and on a checklist the promise reads as done. Slices
      2 to 11 reduced five things: `sdk/README.md` (-92 lines), `security-model.md` (-60),
      `vcs-providers.md` (-24), the root `README.md` (-13) and `model-support.md` §6-§8. Every other
      doc in the "mixed" row was believed to have gained a pointer over unchanged prose, which is the
      two-parallel-full-accounts state rule 1 exists to end. Each section checked
      against the LIVE page before it is cut. CLOSED: all 24 mixed docs open with a pointer and
      twelve have been reduced. The three that had nothing to point AT (`auth`,
      `reusable-operations`, `figma-claude-design-context`) got their destinations in the website's
      phase E and were reduced in the same change, and 15b's parked half and 15c both ran once item
      17 landed. The per-doc state and the per-slice dispositions are their own section:
      [Slice 15 reductions](#slice-15-reductions).
- [x] 16. **Guard the relative links BETWEEN repo docs.** `scripts/check-doc-links.mjs` (detection
      in `doc-links.mjs`, fixtures beside it) resolves every relative markdown link to a path and,
      where it deep-links one, a heading. Generated `CHANGELOG`s are OUT of scope, stated in the
      guard: they are frozen history correctly naming what was true when written, and rewriting one
      to chase a moved file would falsify the record. That is 33 of the 43 dangling targets the scan
      found; the other 10 were fixed, and reading anchors as well as paths turned up two more the
      path-only scan could not see. Three notes for whoever touches it:
      **(a)** it reuses `linkTargets` / `isRelativePath` from the shipped-doc guard and
      `documentAnchors` from the anchor guard, so there is no third copy of either rule to drift.
      **(b)** `headingSlug` gained inline-markup stripping in the same change, because `_` survives
      GitHub's punctuation drop, so a heading ending `_(Application team)_` slugged with two stray
      underscores and every live link to it read as broken.
      **(c)** a link inside a FENCE is an illustration, and reading one as real produced both halves
      of a bad guard: it misses nothing real, and a PowerShell `[Net.ServicePointManager]::…` line
      parses as a reference definition, failing a document nobody could fix.
- [x] 13. The website's page-quality pass (its phase D) landed in
      [cat-factory-website#24](https://github.com/kibertoad/cat-factory-website/pull/24): the
      opening/closing shape on the pages that predate the revamp, task-oriented titles on the how-to
      pages (reference pages deliberately keep noun titles), and both oversized pages split. The
      split that matters here is `extend/custom-agents.md`, which shed gates, step-completion
      resolvers and judges to `extend/custom-gates.html`, so a repo doc reducing a JUDGE section
      points at that page rather than the agents one.
- [x] 17. **Decide who owns the MANIFEST FORMAT, because two reductions are parked on it.** A
      manifest is authored by a user, in the app, with no checkout, so rule 1's reader test puts the
      format on the website. The site's `extend/manifests.md` was scoped as an overview and stops at
      the shared building blocks plus a three-row operations table per manifest, which is why 15b
      kept 152 lines and 15c cannot cut 203. Two outcomes are admissible and the third is not:
      **(a)** the website page gains the field level for both manifests (schema, auth schemes,
      request/response mapping, one worked example each), and 15b's kept half plus 15c's §3 then
      reduce to a pointer; **(b)** the format joins the named exceptions of rule 4 alongside
      `environment-variables.md`, the repo owns it, and both reductions stop being planned. What is
      NOT admissible is leaving it undecided while slices keep scoping cuts toward a page that
      cannot receive them. LANDED AS (a), because nothing about a manifest needs the code open,
      and (b) would put the one format a non-contributor edits by hand behind a checkout. The site's
      page gained the field level for both manifests and states that it is the authority for the
      format; the shared auth-scheme table is stated there ONCE rather than duplicated per manifest,
      which neither repo doc could do. 15b's parked half and 15c then ran, each keeping only what a
      change in THIS repo has to hold: where the Valibot schema lives, and that a field added there
      is a field the website page gains in the same change.
- [x] 18. **Guard the repo → website links from the WEBSITE repo**, which is the option item 14 did
      not consider. It rejected a checked-in page list for rotting in the deletion direction, and
      that objection is right; it does not apply to a check that runs where the pages ARE. The site
      repo already reaches into this one on a schedule for `sync-env-vars.mjs --check`, so the same
      job resolves every `catfactory.ai` URL in the code repo to a page file AND a heading, with no
      second routing table and no network dependence on the live site. LANDED as `scripts/check-repo-links.mjs` there, on a weekly
      `cross-repo-links.yml`, resolving both directions in one pass. Both predicted traps were real
      and are handled: the slug rule is **`@mdit-vue/shared`'s, not GitHub's** (it maps every
      punctuation run to `-`, so `## When the manifest isn't enough` is
      `#when-the-manifest-isn-t-enough`), and the coupling runs BOTH ways, since the generated
      env-var page links `auth.md#enterprise-sso-generic-oidc` here. A third turned up in writing it:
      a REDIRECTED URL still resolves for a reader, so the guard reads each page's own
      `redirectFrom` frontmatter rather than keeping a list, which is the same reason a moved page
      carries its redirect in the first place.

## Slice 15 reductions

The per-doc dispositions behind checklist item 15, one heading per sub-slice so the person running
the next one reads only theirs. They sit here rather than nested under the checklist entry because
a table indented under a list item is an indented CODE BLOCK: it renders as monospace pipe-art, and
the formatter rejects the indentation that produces it, so the checklist is the wrong container for
anything longer than a paragraph.

**Trap that shapes all three: the site splits a feature from its MANIFEST.** A manifest schema lives
on `extend/manifests.html`, not on the feature's own page, so a repo doc reducing its manifest
section points THERE. Reducing it toward the feature page instead loses the schema for every reader.
Item 17 is the follow-on that trap earned: the page it points at does not hold a schema yet.

### Per-doc state of the "mixed" row

Re-derived from both checkouts, because the checklist's prose had drifted from the tree once
already. `pointer` means the doc opens by naming the website page that owns its user-facing account.

| Doc                               | Pointer | Reduced        | What it still owes                                                            |
| --------------------------------- | ------- | -------------- | ----------------------------------------------------------------------------- |
| `model-support.md`                | yes     | yes (§6-§8)    | nothing                                                                       |
| `security-model.md`               | yes     | yes (-60)      | nothing                                                                       |
| `vcs-providers.md`                | yes     | yes (-24)      | nothing                                                                       |
| `custom-agents.md`                | yes     | yes (15a)      | nothing                                                                       |
| `environments-integration.md`     | yes     | yes (15b + 15e) | nothing: the manifest half went once item 17 landed                          |
| `runner-pool-integration.md`      | yes     | yes (15c)      | nothing: §3 is a pointer, 701 → 520 lines                                     |
| `auth.md`                         | yes     | yes (15f)      | nothing                                                                       |
| `reusable-operations.md`          | yes     | yes (15g)      | nothing                                                                       |
| `figma-claude-design-context.md`  | yes     | yes (15h)      | nothing                                                                       |
| `llm-telemetry.md`                | yes     | not needed     | nothing: the clean-split model to copy                                        |
| `custom-agent-roles.md`           | yes     | not assessed   | a read against `extend/custom-agents.html`                                    |
| `custom-agent-gate-ergonomics.md` | yes     | not assessed   | a read against `extend/custom-gates.html`                                     |
| `custom-binary-stores.md`         | yes     | not assessed   | a read against `extend/custom-providers.html`                                 |
| `native-environment-adapter.md`   | yes     | not assessed   | a read against `extend/custom-providers.html`                                 |
| `local-k3s-environments.md`       | yes     | not assessed   | a read against `operate/environments.html` + `deploy/kubernetes.html`         |
| `document-sources.md`             | yes     | not assessed   | a read against `guide/issue-sources.html`; the heaviest remaining UI how-to   |
| `initiative-presets.md`           | yes     | not assessed   | a read against `guide/initiatives.html`                                       |
| `storage-and-retention.md`        | yes     | not assessed   | a read against `operate/upgrades-and-retention.html`                          |
| `github-integration.md`           | yes     | not assessed   | a read against `deploy/github-app.html`                                       |
| `github-operations.md`            | yes     | not assessed   | the runbook stays; setup already moved                                        |
| `kubernetes-topology.md`          | yes     | not assessed   | a read against `deploy/kubernetes.html`                                       |
| `mcp-tool-servers.md`             | yes     | not assessed   | a read against `extend/mcp-server.html` and the custom-agents anchor          |
| `debug-api.md`                    | yes     | not assessed   | a read against `extend/public-api.html`                                       |
| `reports.md`                      | yes     | not assessed   | a read against `operate/observability.html`                                   |

**"Not assessed" is the honest state and it is not "done".** Twelve rows have had a section-by-section
read against the live page; twelve have a pointer over prose nobody has compared. That is a weaker
position than the reduced rows and a stronger one than where this item started, where the pointer
itself was missing. The next pass takes them in the order above and writes its verdict into the row,
including "nothing to cut", which `llm-telemetry.md` shows is a real answer.

### 15a. `custom-agents.md`: DONE (553 → 326 lines)

Every section was checked against the live page before it was cut, and the plan held except where
the disposition says otherwise.

| Section                           | Disposition                                                                                                                                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The governing principle           | KEPT. "Zero `switch(agentKind)` in the container" is an invariant a contributor breaks, not a how-to.                                                                                                                                                                   |
| The three stages                  | CUT to the stage names plus the `RepoFiles` source link, pointing at the site's "The mental model".                                                                                                                                                                     |
| The seams                         | CUT: the registration example and the `AgentKindDefinition` table are both on the site, and the site's table is the LONGER one (`tuning`, `gatable`, `fanOutMultiRepo`). Kept the `standardsDelivery: 'context-files'` rationale and `registeredKindRequiresContainer`. |
| Variations of an EXISTING kind    | KEPT. The site has four sentences; these lines are WHY a variant is not a kind, which is the safety property.                                                                                                                                                           |
| Capabilities → Skills             | KEPT. Deeper than the site: the three ref forms, bundled vs catalog resolution, harness-aware install, the overlap with the built-in `skill` KIND. Cut only the registration snippet the site carries.                                                                  |
| Capabilities → Tool servers (MCP) | CUT to one paragraph naming `mcp-tool-servers.md` as the authority. The four "altitude" bullets it kept were four facts that doc states in full.                                                                                                                        |
| Capabilities → Binary generators  | CUT to the two-registries split (storage is a selected foundational service, generation is the deployment's own registry) plus the link. Verified: `binary-output-foundational-storage.md` owns every other line of it.                                                 |
| Judges                            | CUT to why it is the fourth bucket and why neither other seam fits, with the registration on the site and the design (D9's model-pin precedence included) in `judge-registry.md`.                                                                                       |
| The worked example                | CUT to one paragraph naming what `backend/internal/example-custom-agent` registers, which is the executable copy.                                                                                                                                                       |
| Status / scope                    | KEPT.                                                                                                                                                                                                                                                                   |

Two couplings the cut had to carry, both invisible from the page itself: `agent-prompt-overrides.md`
deep-links `#variations-of-an-existing-kind-alternate-prompts-programmatically` and
`custom-agent-roles.md` deep-links `#capabilities-skills-and-tools`, so both headings are
load-bearing and stay. `custom-agent-roles.md` also pointed AT the `AgentKindDefinition` table this
slice deleted; it now points at the section that survived, in the same change.

### 15b. `environments-integration.md`: DONE (442 → 352 lines)

**The plan was wrong in the direction this slice exists to catch, and reading the live pages before
cutting is what caught it.** The plan assigned `## The manifest` (152 lines) to
`extend/manifests.html#environment-provider-manifest` on the strength of that section existing. It
exists and it stops above the field level: a three-row operations table and one sentence naming
`{{input.*}}` / `{{provision.*}}`. There is no field schema, no auth-scheme detail beyond the list
of type names, no git/PR/repo context table and no worked example. Cutting toward it would have
deleted the only account of the manifest format anyone can read. The page count (18 sections, now 25) is what made the site look like the senior partner, and a section count is not coverage.

So the manifest half STAYS, and says in the doc why: the site owns the shared concepts, this doc
owns the field level until a website slice lands it. That slice is the tracker's, not this one's:
this repo cannot land a website page, and the ordering rule forbids cutting ahead of one.

| Section                                            | Disposition                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-ins callout                                  | CUT to the facade-availability asymmetry the site's "Choosing a backend" does not explain: `cloudflare` runs everywhere (it drives the repo's own preview workflow over the Deployments API, so outbound HTTPS is the whole requirement) and `compose` is local-only (host Docker daemon). The choice itself points at the site. |
| `## How it works`                                  | CUT the user-visible narration the site's own "How it works" carries; kept the four mechanics it does not state (deterministic dispatch, dot-path capture, `test.environmentUrl` wiring, the 2-minute sweep and its TTL source).                                                                                                 |
| `## Enabling it`                                   | CUT the `openssl` / `wrangler secret put` recipe (site + `environment-variables.md`); kept the assembly rule and the at-rest envelope (AES-256-GCM, per-record salt + IV, HKDF, versioned `v1.…`).                                                                                                                               |
| `## The manifest` + worked example                 | KEPT, against the plan. See above.                                                                                                                                                                                                                                                                                               |
| `### Auth schemes`                                 | KEPT the fields/effect table (the site lists type NAMES only); cut the secrets-by-reference rationale to the site's own section on it.                                                                                                                                                                                           |
| `## Code-adapter seam`                             | CUT to two facts about how an adapter sits INSIDE this integration (everything around the provider is unchanged; the SSRF guard is the engine's, so installing code is not a way around it). The port sketch and the registration snippet were a second copy of a sibling repo doc.                                              |
| `### Confirming a teardown`                        | MOVED to `native-environment-adapter.md`, which is the contract for writing an adapter and did not document the method at all. One paragraph stays here for the invariant (a clean `teardown()` is not a reclaim).                                                                                                               |
| `## Reaching an internal / VPN-hosted …`           | CUT the variable table and the `wrangler.toml` block (site + `environment-variables.md`); kept three facts about the guard: it covers three surfaces, it is facade-level on purpose, and the two integrations resolve their policies independently.                                                                              |
| `## Registering a provider`                        | CUT the `curl` block: registration is the in-app manifest editor and the site owns it. Kept the endpoint list and the write-only secret contract.                                                                                                                                                                                |
| `## Provisioning & discovery`, `## Security notes` | KEPT, per plan.                                                                                                                                                                                                                                                                                                                  |

Every heading survived the cut on purpose: five of them are deep-linked from elsewhere in the same
file (six links, one heading targeted twice), and per the gotcha below nothing would have gone red
had one been renamed.

### 15c. `runner-pool-integration.md`: DONE (701 → 520 lines)

The MILD case and the one most likely to be over-cut. `operate/runner-pools.html` has four sections;
almost everything here is genuinely deeper. The runner image and job protocol, the k3s/Nomad
mapping, the trust boundary and scaling all stayed, as planned.

**`## 3. Describe your scheduler as a manifest` (203 lines) was the one section the plan assigned
away, and it could not be cut until item 17 landed**, for the reason 15b recorded on the sibling
manifest: the page it was assigned to was a three-row operations table. With the website owning the
field level it reduces to a pointer plus two facts that are about THIS repository rather than about
authoring a manifest: the Valibot schema's location (so a field added there is a field the page
gains in the same change), and that the interpreter is one generic provider with no per-scheduler
code path, so a shape the manifest cannot express is a custom runner backend rather than a special
case.

The heading survived the cut on purpose: `mcp-tool-servers.md` deep-linked it, and the section
numbering is referenced in prose elsewhere in the file. That inbound link was repointed at the
website page in the same change, because what it was sent for is no longer here: keeping the heading
is what stops the link 404ing, and repointing it is what makes it useful.

### 15d. The pointer sweep: seven docs, one change

Seven of the ten pointerless docs needed nothing but the pointer, so they rode together rather than
one PR each: `custom-agent-roles`, `custom-agent-gate-ergonomics`, `custom-binary-stores`,
`native-environment-adapter`, `local-k3s-environments`, `document-sources` and `initiative-presets`.
The other three had nothing to point AT and waited on the website's phase E, which is 15f to 15h.

Two things the sweep settled that a reduction PR would have buried:

- **A pointer names what THIS doc is, not only where the how-to went.** "Setting one up is on the
  website" alone leaves the reader guessing whether anything here is still worth reading. Each of
  the seven ends with a clause naming what it keeps ("this page is the ROLE layer under it", "the
  CONTRACT for writing one adapter"), which is also what makes the later depth read possible: the
  claim is now written down and can be checked against the file.
- **Two of the seven point at a page that already links BACK.** `custom-binary-stores.md` and
  `native-environment-adapter.md` are both reached from `extend/custom-providers.html`, so the pair
  was one-directional until now, in the direction that helps the reader least: somebody in the
  repository could not find the page, while somebody on the page could find the doc.

### 15e. `environments-integration.md`: the parked manifest half (352 → 226 lines)

15b kept `## The manifest` and said in the doc why. Item 17 removed the reason. What stays is three
facts, and the shape of them is the model for the next reduction of this kind: not a summary of the
page, but the things a change in this repository has to keep true. Where the schema lives. That
`{{input.*}}` on a `deployer` step is DERIVED by the engine from the block and its open pull
request, which is why an explicit request input winning is a design decision rather than a fallback.
And that a dot-path is the deliberate boundary of the integration, so a platform that outgrows it
gets the code-adapter seam rather than an expression language.

### 15f. `auth.md` (523 → 440 lines)

Cut: the OAuth application registration recipe, the two variable tables, the SSO configuration
table, the issuer URLs by provider, the four boot refusals in operator form, and the three reasons
SSO is not UI-configurable. All of it is what an operator sets, and all of it is now on
`deploy/sso.html`.

Kept, and worth naming because the cut looks bigger than it is: every leg of every flow, what each
one verifies (the issuer-qualified subject, asymmetric-only ID tokens, the single JWKS refetch, the
userinfo subject match, the separate cookie audience), and the whole of session revocation including
the `directory` versus `indeterminate` evidence distinction. That distinction is the sharpest thing
in the file and it is engine behaviour, not configuration: acting on the second as if it were the
first turns a configuration regression into a deployment-wide forced sign-out.

Two couplings the cut had to carry. `docs/environment-variables.md` deep-links
`#enterprise-sso-generic-oidc`, so that heading stays. And `enterprise-sso-oidc.md` deep-linked the
section this slice renamed, which is exactly the breakage item 16's guard was written for: the guard
caught it in the same run.

### 15g. `reusable-operations.md` (675 → 481 lines)

The largest single reduction of the initiative, and the one where the split line was clearest.
Everything an author DOES (which vehicle, the descriptor's fields, the form vocabulary, the
boot-validation codes, the composition-root walkthrough, what users see, suppression, public-API
discovery) went to `extend/reusable-operations.html`. Everything the ENGINE guarantees stayed: no
`switch(taskType)` anywhere, the fold's three emit points, the value-authoritative drift rule, the
three drift guards behind the facade dependency rule, adoption on the run path, and the mothership
position.

The bundle section is the pattern to copy when the two halves are genuinely about the same fields:
rather than summarising the descriptor, the table now says where each field is READ, which is the
half a change here has to keep true and the half the page has no reason to carry.

### 15h. `figma-claude-design-context.md` (357 → 341 lines)

The smallest reduction, and deliberately so. Most of this doc is integration internals (the
source-neutral `DesignContext` model, why each cap is shaped the way it is, the freshness ladder's
cost model, the per-provider endpoint shapes) that no user-facing page should carry. What moved was
the problem statement, the cap table in the form that tells a reader what to DO about each one, and
the Claude Design workflow.

Claude Design is the interesting row: the WORKFLOW moved, and the reason there is no provider
STAYED, because a per-user-PAT Claude Design provider was built here and removed. That is a record
of a rejected design, which is contributor material by definition, and deleting it would let the
next iteration re-propose it.

`llm-telemetry.md` is the model of a clean split and needs nothing: every section is an internal rule
with no counterpart on the site. Copy its shape.

## Docs added since this tracker was written

Checked against `main` on 2026-08-08, after the tracker's base commit:

| Doc                                                         | Classification | Outcome                                                                                                                                                                                                      |
| ----------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backend/docs/custom-binary-stores.md`                      | mixed          | User-facing half (what you implement, how a store is selected, what it owes the sweeps) added to the website's custom-providers page as the third code seam; repo doc keeps the cache and resolution design. |
| `backend/docs/adr/0050-public-api-headless-completeness.md` | contributor    | Stays. An ADR is a decision record by definition.                                                                                                                                                            |
| `backend/internal/conformance/README.md`                    | contributor    | Stays. It describes this repository's own test suite.                                                                                                                                                        |

## What a reduction actually turns up

Two classes the per-doc audit structurally could not see, both found by reading a doc against
everything around it rather than against its classification.

### The site's page exists and stops shallower than the doc

The audit asks whether a website page exists, and existence is what its cells record. Both cuts
attempted since found the named page stopping above the field level the repo doc carries, so the
answer to "does the site own this" was yes by the table and no by the page. The rule: before
cutting a section, open the target and check DEPTH, not presence, and write the verdict back into
the audit cell so the next slice inherits it. Where the shortfall is structural rather than a
one-off (both manifest sections, on a page scoped as an overview), the fix is an ownership decision
upstream of the reduction, not a smaller cut: item 17.

### Repo-to-repo duplication

The audit classified every doc by READER and asked, per doc, what the website should own. It never
asked what a SIBLING doc already owns, so this class was invisible to it: two repo docs, same
audience, same material, neither aware the other is authoritative. It is the same failure mode as
the website duplication (rule 1's "two parallel full accounts"), and it is not fixed by the split,
because moving the user-facing half to the site leaves both copies of the internal half behind.

Recorded here, deliberately NOT fixed in the execution PR: each needs its own judgement about which
doc is the authority, and folding that into a website slice would hide it. The first three were in
`custom-agents.md` and were resolved by slice 15a; the fourth was found by 15b and resolved with it.
The judgement is recorded per row rather than left to the next reader.

**Expect it, rather than tripping over it.** Both slices so far found the doc they were reducing
restating a sibling, and neither found it by looking: the audit's per-doc question is "what should
the WEBSITE own", which cannot see it. Ask it deliberately, alongside the depth check above.

| Restated in                                         | Already owned by                                         | Judgement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `custom-agents.md` → "Tool servers (MCP)"           | `mcp-tool-servers.md`                                    | Resolved: that doc is the authority and `custom-agents.md` now only says a tool server resolves in the container EXECUTOR rather than the engine, which is the one fact placing it in THIS doc's model.                                                                                                                                                                                                                                                                                         |
| `custom-agents.md` → "Judges"                       | `docs/initiatives/judge-registry.md`                     | Resolved toward the live tracker, NOT deferred behind its ADR conversion: that conversion is due when the tracker's own slice 12 lands, and blocking a documentation slice on an unrelated engine slice would leave the duplicate standing meanwhile. The cost is one edit when the tracker converts, and NOTHING WOULD RED IF IT WERE MISSED: see the unguarded-repo-links gotcha. So the conversion PR, which `git rm`s the tracker per CLAUDE.md, is where the repoint has to be remembered. |
| `custom-agents.md` → "Binary-output generators"     | `docs/initiatives/binary-output-foundational-storage.md` | Verified before cutting, and the shape WAS the same: the initiative doc states the brief, the closed content-type vocabulary, both admission refusals and the credential rule at greater depth than the section restating them.                                                                                                                                                                                                                                                                 |
| `environments-integration.md` → "Code-adapter seam" | `native-environment-adapter.md`                          | Resolved toward the sibling, which calls itself "the contract for writing one" and carries the port, the connect-form methods, the registration snippet and the `providerConfig` SSRF rule. Same tell as 15a: the section named it as the full model and then restated it, registration snippet included. `confirmTeardown` went the other way, being documented ONLY in the restating doc: it MOVED into the contract rather than being deleted from one of two copies.                        |

**The rule this suggests, and it held on the second pass:** a doc that names another as "the full
model" may not also contain that model. Say what the reader needs to decide whether to follow the
link (one paragraph), and link. `custom-agents.md` broke it three times in one file, each time
inside a section that opened by naming the authority.

**And the corollary 15a added: pointing at a live TRACKER is allowed.** A tracker is contributor
material by classification and converts to an ADR on its own schedule, so making a doc wait for
that conversion just keeps a duplicate alive. Point at the tracker and move the link when it
converts.

## Gotchas

- **Land the website page before the repo link to it.** A repo doc linking a 404 fails
  silently for every reader. This tracker's header obeys its own rule: it links the open website
  PR, not the file that PR adds.
- **The website restructure changes URLs.** Its tracker's phase A regroups navigation without
  moving files precisely so slices here can start early; slices that link moved pages wait
  for the website's redirect slice, or link section anchors that survive the move.
- **Landing the website page FIRST is the ordering rule, and the generated env page is the one
  exception**: it is rendered from the repo file, so the repo edit comes first and the site's
  `sync-env-vars.mjs` run comes second, in the website PR.
- **`check-shipped-doc-links.mjs` checks BOTH directions of a shipped doc's links.** A published
  package `README` may not link a repo-relative path outside its own package, so website links
  from one must be absolute URLs. And a repo-absolute
  `https://github.com/kibertoad/cat-factory/blob/main/...` link is resolved against this checkout,
  so DELETING OR RENAMING a linked repo doc reds CI in the slice that does it. Inbound links from
  shipped `README`s today: `backend/docs/public-api.md` 4, `sdk/README.md` 3,
  `backend/docs/reusable-operations.md` 2, `backend/docs/custom-agents.md` and
  `backend/docs/model-support.md` 1 each, with `public-api.md` and `sdk/README.md` each carrying one
  anchored link. A slice reducing one of those to a pointer keeps the anchors it names, or repoints
  the inbound links in the same PR. Slice 7 took the second route for `#pointing-an-sdk-at-localhost-or-a-mock`
  and slice 2 took the first, because `model-support.md`'s anchors are linked from RUNTIME ERROR
  MESSAGES (`agents/src/providers/docs.ts`), where a stale link reaches an operator with no way back.
- **A relative link between two REPO docs is GUARDED now (item 16), and the belief that it already
  was is what let the class grow.** Two guards sound like they cover it and each covers something
  adjacent: `check-shipped-doc-links.mjs` walks the published package directories only, so it never
  opens a file under `backend/docs/` or `docs/`, and `check-doc-anchors.mjs` resolves only the URLs
  that CODE builds. `check-doc-links.mjs` reads the ordinary markdown link. It matters most where
  this repo deletes docs ON PURPOSE: CLAUDE.md says a completed initiative tracker converts to an
  ADR and is `git rm`ed in the same PR, which dangles every doc that linked it, and six of the
  twelve live breakages were exactly that. **Still repoint by hand in the PR that moves a file**:
  the guard tells you the link is dead, and only you know what it should now say.
- **An anchor linked from CODE is a different coupling from one linked in markdown, and slice 9
  broke it.** Reducing `vcs-providers.md` deleted `## Setup`, which the GitLab webhook-rejection
  warning deep-linked as `DOCS.vcsProviders('setup')`: an operator following it from the logs landed
  on a page with no setup section, in the same commit that removed the `GITLAB_WEBHOOK_SECRET`
  content they were sent for. `signatureLog.test.ts` asserted the message contains
  `vcs-providers.md#setup` and passed throughout, because a test on a composed string cannot see
  whether the heading exists. The fix is the general one, not a restored heading: setup now belongs
  to the website, so the remedy names the page that owns it (`SITE_DOCS.vcsSetup`), and
  `check-doc-anchors.mjs` resolves every such target. **Before reducing a doc, grep `config/docs.ts`,
  `vcs-errors.ts` and `providers/docs.ts` for it**; a remedy whose instruction the website now owns moves to `SITE_DOCS`,
  and one about this repo's internals keeps its heading.
- **The ordering rule cuts both ways across two repositories, and the guard for it is
  DELIBERATELY not a pull-request gate.** "Land the website page FIRST" is right, but the two repos
  merge independently and neither CI can see the other, so for the life of a paired change one side
  legitimately leads. Item 18's `check-repo-links.mjs` runs WEEKLY in the website repo for exactly
  that reason: as a gate it would go red on the reviewing repo for a reason that pull request cannot
  fix, which is how a guard gets ignored and then deleted. So it stays a human step here (LOAD the
  page before you link it, and say in the PR that you did) with a scheduled net underneath, and a
  paired change can confirm itself by running that workflow against the branch.
- **A repo → website link is CHEAP to write and the count is now the exposure.** Over a hundred
  `catfactory.ai` links are built from this repo (docs, code and shipped READMEs), and every
  reduction adds more, since the pointer IS the deliverable. Item 18 is what resolves them. The reader who
  loses is the one following a pointer out of a doc that no longer carries the content, which is the
  worst failure the split can produce: the material exists nowhere the reader can reach.
- **`check-reserved-env-keys.mjs` is a SAME-REPO coupling, not a file-path one.** It reads
  `docs/environment-variables.md` and fails when a documented variable is missing from the reserved
  set, and its whole value is that this fires in the PR that adds the variable: the documentation
  sweep already requires the row, so the reserved set cannot rot unnoticed. With the prose on the
  website, a newly added `SOMETHING_URL` is documented in a repo whose CI never sees it, stays
  nameable as a capability credential, and its value is read off the deployment environment into a
  prompt-injectable agent process. So the canonical list stays here; re-pointing the guard at the
  website is not an option slice 3 may take.
- **`check-package-catalog.mjs` pins every package name into the root README's layout tables.**
  The repository-layout pair is therefore the one duplicate that cannot be resolved by deletion:
  slice 10 may shrink the prose around the tables, but the rows themselves stay, and
  `reference/packages.md` remains a second copy kept in step by the site's `sync-docs` pass.
- **The website's `sync-docs` skill reads this repo's commit history.** A commit that removes
  or relocates a repo doc should say where the content went, so the sync pass re-links
  instead of re-importing deleted material.
