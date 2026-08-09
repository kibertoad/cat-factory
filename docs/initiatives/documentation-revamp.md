# Documentation revamp: the repo ⇄ website split

Status: **executing; every "mixed" doc now has a landed verdict and no row says "unread".** Items 21
and 22 cleared the last two, both of which were BLOCKED debt rather than unassessed prose, and both
were cleared the way the tracker said they would be: the website page came first
([cat-factory-website#29](https://github.com/kibertoad/cat-factory-website/pull/29)), then the cut.

**The finding this phase adds is the previous one turned around.** Item 20 caught two WEBSITE pages
that had stopped describing the code. Reducing `document-sources.md` caught the same rot on this
side: it opened by naming the two providers that shipped when it was written, and there are six.
Nothing pointed at it, no guard could see it, and the reduction is what read the file end to end.
Where item 20's rule says believe the repo doc when the two disagree, the corollary is that the
belief is about the DESIGN half, never the inventory: a list of what ships rots wherever it lives,
so what replaced it here is the picklist the code reads.

What is open: nothing in the reduction pass. What remains is the initiative's own close-out, which
is item 23.

The sibling tracker is
[`planning/documentation-revamp.md`](https://github.com/kibertoad/cat-factory-website/blob/main/planning/documentation-revamp.md)
in the website repo, now carrying a phase H for the two destinations this phase's cuts needed.

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

| Topic                            | Repo doc                                                                                          | Website page                                                                                                                                   | Proposed authority                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom agents                    | `backend/docs/custom-agents.md`, `custom-agent-roles.md`, `custom-agent-gate-ergonomics.md`       | `extend/custom-agents.md`, `extend/custom-gates.md`                                                                                            | Website owns authoring how-to; repo keeps engine design (registries, the three stages). All three now open with a pointer.                                                                                                                                                                                                                                                             |
| Public API                       | `backend/docs/public-api.md`                                                                      | `extend/public-api.md`, `extend/api-reference.md` (GENERATED, owns SHAPES)                                                                     | Three-way, settled by item 12: the site's page owns the integrator's first read, the generated page owns every operation's path/scope/parameters/schemas, and the repo doc keeps what the spec cannot express (refusal codes behind each `4XX`, caps, ordering, the worked walkthroughs).                                                                                              |
| Model support                    | `backend/docs/model-support.md`                                                                   | `guide/model-providers.md`                                                                                                                     | Website owns configuration and usage; repo keeps provisioning internals. Pilot slice.                                                                                                                                                                                                                                                                                                  |
| Runner pools                     | `backend/docs/runner-pool-integration.md`                                                         | `operate/runner-pools.md`                                                                                                                      | Website owns operating a pool; repo keeps the integration protocol.                                                                                                                                                                                                                                                                                                                    |
| Environments                     | `backend/docs/environments-integration.md`, `local-k3s-environments.md`, `kubernetes-topology.md` | `operate/environments.md`, `deploy/kubernetes.md` + `deploy/kubernetes-topology.md` (owns the LAYOUT), `extend/manifests.md` (owns the FORMAT) | Website owns setup, operation and cluster layout; repo keeps provider integration design. Both exceptions this row carried are closed: item 17 gave the manifest page the field level, and item 21 gave the site a topology page, so the connect form is no longer the deepest thing a cluster operator can read.                                                                      |
| GitHub App                       | `backend/docs/github-integration.md`, `github-operations.md`                                      | `deploy/github-app.md`                                                                                                                         | Website owns setup and the operations runbook; repo keeps integration design.                                                                                                                                                                                                                                                                                                          |
| Environment variables            | `docs/environment-variables.md`                                                                   | `reference/environment-variables.md` (GENERATED), `deploy/configuration.md`                                                                    | The repo file is canonical: `check-reserved-env-keys.mjs` reads it and the site RENDERS it into the reference page, so that page is the one item 3's `--check` guards. `deploy/configuration.md` narrates by hand the subset an operator sets, and links the generated page for the rest.                                                                                              |
| Glossary                         | `docs/glossary.md`                                                                                | `reference/glossary.md`, `guide/core-concepts.md`                                                                                              | Website owns the product vocabulary; the repo glossary keeps the code-level naming map (dir ⇄ package names, internal seams).                                                                                                                                                                                                                                                          |
| Agent trust model                | `backend/docs/security-model.md`                                                                  | `reference/agent-isolation.md`, `reference/security-model.md`                                                                                  | Website owns the operator-facing account of what an adversarial agent can reach; repo keeps the full layer-by-layer boundary and the write-path rules.                                                                                                                                                                                                                                 |
| Storage and retention            | `backend/docs/storage-and-retention.md`, `llm-telemetry.md`                                       | `operate/observability.md`, `operate/upgrades-and-retention.md`                                                                                | Website owns retention windows and what is kept; repo keeps the table/rollup design.                                                                                                                                                                                                                                                                                                   |
| Repository layout                | root `README.md` tables                                                                           | `reference/packages.md`                                                                                                                        | Website owns the orientation map; the repo tables stay, pinned by `check-package-catalog.mjs`.                                                                                                                                                                                                                                                                                         |
| VCS support                      | `backend/docs/vcs-providers.md`, `gitlab-parity.md`                                               | `reference/vcs-support-matrix.md`                                                                                                              | Website owns the parity matrix and provider setup; repo keeps the provider-layer map and the accepted-gap log. Landed in slice 9.                                                                                                                                                                                                                                                      |
| SDKs and MCP                     | `sdk/README.md`, `sdk/mcp/README.md`                                                              | `extend/sdks.md`, `extend/mcp-server.md`                                                                                                       | Website owns consuming a client; the READMEs keep the generation chain, the smoketest and releases. Landed in slice 7.                                                                                                                                                                                                                                                                 |
| Integration manifests (BOTH)     | `runner-pool-integration.md` §3, `environments-integration.md` "The manifest"                     | `extend/manifests.md` (OWNS the format)                                                                                                        | DECIDED (item 17, outcome a): the website owns the field level for both manifests, and the shared auth-scheme table is stated there ONCE rather than per manifest. Both repo sections reduced to a pointer plus what a change HERE has to keep true (the Valibot schema's location, the derivation of `{{input.*}}`).                                                                  |
| Debug API and reports            | `backend/docs/debug-api.md`, `backend/docs/reports.md`                                            | `extend/public-api.md`, `operate/observability.md`                                                                                             | Resolved without new pages: both readers were already served, so each doc points at the page that owns its reader and keeps the design. Was a "none" row; this is the rot the paragraph above describes, caught on the 2026-08-09 re-check.                                                                                                                                            |
| Enterprise SSO                   | `backend/docs/auth.md`                                                                            | `deploy/sso.md` (owns setup + admission)                                                                                                       | CLOSED. Was the sharpest repo-only row: the site named three sign-in providers and never mentioned OIDC. The page owns registering the application, the nine variables, the four boot refusals and the directory-as-allowlist model; the doc keeps the legs, what each verifies, and revocation.                                                                                       |
| Reusable operations              | `backend/docs/reusable-operations.md`                                                             | `extend/reusable-operations.md`                                                                                                                | CLOSED. The reader is a deployment author writing their own package against published seams, which is the Extend audience. The doc keeps the engine side: no `switch(taskType)`, the fold's three emit points, the drift guards, the mothership position.                                                                                                                              |
| Design context                   | `backend/docs/figma-claude-design-context.md`                                                     | `guide/design-context.md`                                                                                                                      | CLOSED. Was a tip box on `guide/issue-sources.md`. The page owns connecting a source, what the agent receives, what each cap asks the reader to DO, and the freshness verdicts; the doc keeps the source-neutral model and the ladder's cost model.                                                                                                                                    |
| Document sources                 | `backend/docs/document-sources.md`                                                                | `guide/issue-sources.md` (owns connecting, attaching, expanding), `guide/design-context.md`, `guide/documents.md`                              | CLOSED by item 22. Never a missing-page row: the page existed and was deep, and what stayed behind was user-visible behaviour written as implementation, which reads as internal design until someone checks. The doc keeps the provider port, the two credential homes, the link and freshness invariants, and the RBAC route map a test names as its rationale.                      |
| Repo-only, no website page today | `backend/docs/local-kubernetes-setup-windows.md`                                                  | none                                                                                                                                           | The row is not empty after all, which is the rot the note above predicts an empty cell hides. This doc was classified "user-facing, unmoved" on the grounds that the Kubernetes page did not need it yet; item 21 changed that premise, so the decision belongs to the close-out (item 23) rather than to this cell. Re-derive the rest of the row there, against the live navigation. |

## Classification (slice 1)

Every doc under `backend/docs/` and `docs/`, classified by READER. "Mixed" means the topic serves
both audiences and is split by depth: the website page owns the user-facing account and the doc here
keeps the internal design plus a link.

Rather than one row per file, whole categories classify together and only the exceptions are named,
because a per-file table of 160 rows rots faster than the docs it describes.

| Category                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Classification          | Rule                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backend/docs/adr/*` (50 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | contributor             | A decision record is written for whoever changes the code next. None moves.                                                                                                                                  |
| `docs/initiatives/*` (64 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | contributor             | Describes a target state that may be partly built. Never a user-facing source.                                                                                                                               |
| `docs/internal/*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | contributor             | This repository's own process.                                                                                                                                                                               |
| Engine flow docs: `agent-prompt-overrides`, `bug-hunt`, `bug-triage-pipeline`, `concurrency-and-redis`, `consensus-panels`, `container-reaping`, `env-lifecycle`, `execution-state-machine`, `gitlab-parity`, `individual-subscription-usage`, `infrastructure-providers-window`, `logging`, `per-service-provisioning`, `pipeline-catalog-lifecycle`, `pipeline-pr-descriptions`, `prompt-caching`, `ralph-loop`, `requirements-review`, `review-debt-friction`, `service-connections`, `visual-confirmation`                   | contributor             | Each describes a seam, an invariant or a flow the code implements. The product behaviour they produce is described on the website by the page that owns that feature, and none of these is that page.        |
| `model-support`, `security-model`, `storage-and-retention`, `llm-telemetry`, `custom-agents`, `custom-agent-roles`, `custom-agent-gate-ergonomics`, `mcp-tool-servers`, `custom-binary-stores`, `github-integration`, `github-operations`, `vcs-providers`, `environments-integration`, `local-k3s-environments`, `native-environment-adapter`, `kubernetes-topology`, `runner-pool-integration`, `document-sources`, `auth`, `reports`, `debug-api`, `reusable-operations`, `initiative-presets`, `figma-claude-design-context` | mixed                   | Split by depth. All 24 open with a pointer naming the website page that owns the user-facing account, and all 24 now carry a landed verdict. Per-doc state: item 15's inventory.                             |
| `docs/environment-variables.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | user-facing, stays      | A CI guard reads it. The website RENDERS it.                                                                                                                                                                 |
| `docs/glossary.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | contributor             | Code-level naming map; the product vocabulary is the website's glossary.                                                                                                                                     |
| `docs/README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | contributor             | This repository's own orientation and process.                                                                                                                                                               |
| `backend/docs/public-api.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | mixed, split three ways | The SHAPES are generated onto the site (item 12); the refusal vocabulary and the walkthroughs stay. Item 12b is what remains.                                                                                |
| `backend/docs/local-kubernetes-setup-windows.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | user-facing, unmoved    | A platform-specific setup recipe with no website home. Held on the grounds that the Kubernetes page did not need it; item 21 gave that page a topology sibling, so the premise is stale and item 23 decides. |
| `sdk/README.md`, `sdk/mcp/README.md`, `sdk/*/README.md`, `backend/packages/*/README.md`, `deploy/*/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                    | named exception         | A README that ships in a published tarball stays self-contained and links the website by absolute URL.                                                                                                       |
| `docs/openapi.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | named exception         | Generated. The site links or renders it, never recreates it.                                                                                                                                                 |

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
- [x] 12. **RENDER the `/api/v1` reference; never move it.** `sync-openapi.mjs` landed beside
      `sync-env-vars.mjs` in the website repo, emitting `extend/api-reference.md` from
      `docs/openapi.json`: every operation with its minimum scope, parameters, request body and
      responses, grouped by the spec's own tags, plus a field table per schema. `--check` compares
      against this repo on a weekly schedule; `--verify` blocks a pull request there on the half
      needing no second checkout. The generator ASSERTS what makes the output a reference rather
      than a dump, each failing the render: every operation states a scope (one that did not would
      read as an endpoint needing no authorization), summaries are unique because they become the
      anchors, every operation carries exactly one tag because the grouping IS the navigation, and
      no two headings on the page slug the same.
- [x] 12b. **The reduction half, re-scoped by measuring instead of estimating.** Three revisions of
      this tracker described `public-api.md` as "2,029 lines of prose companion to the spec", which
      framed the cut as enormous and is why it was deferred four times. It is wrong. The
      `## Reference` section is 1,352 lines of which **125 are endpoint-table rows**; the rest is
      worked walkthroughs, refusal vocabularies and judgement. So the generated page does not
      subsume this section, and the anchor inventory that was going to be the first step is not the
      blocker either (the load-bearing set is five: `#from-an-mcp-host` from `sdk/mcp/README.md`,
      `#run-evidence-report--outcome--artifacts`, `#attaching-requirements-documents`,
      `#spend-by-repository-ticket-or-run` and `#merge-evidence-apiv1merge-records`).
      **What blocks the table cut is the spec's own shape**: it collapses every client failure into
      one `4XX` with a shared `ErrorResponse`, so `429 too_many_active_runs` and the five-in-flight
      cap that raises it are on no generated page, and gutting the tables toward one would delete
      the surface's whole refusal vocabulary. What CAN go is narrower and is what 12b is: the
      request/response bodies still spelled inside `Behaviour` cells, which the generated page now
      owns field by field. The doc says so at the top of the section, so the next pass reads the
      verdict rather than re-deriving it. Fixing the spec to declare its refusal codes per operation
      would change this answer, and is a public-API change rather than a documentation one.
- [x] 14. Enforce the coupling slice 9 broke silently. `scripts/check-doc-anchors.mjs` resolves
      every doc URL built in code to a file AND a heading, across all THREE modules that build them
      (`config/docs.ts`, `vcs-errors.ts`, `providers/docs.ts`: each layer sits below the last and
      cannot import it). Deliberately NOT guarded: whether a catfactory.ai link resolves. That needs
      either the network, which fails on the website's outages rather than on our mistakes, or a
      checked-in copy of the site's page list, which is a second routing table to keep in step and
      rots in the direction that matters most, since a page deleted from the site would stay listed
      and keep passing.
- [x] 15. **Finish the reductions the pointers only announced.** ([#1884](https://github.com/kibertoad/cat-factory/pull/1884)) A pointer at the top of a doc is
      not the split; it is the promise of one, and on a checklist the promise reads as done. Slices
      2 to 11 reduced five things: `sdk/README.md` (-92 lines), `security-model.md` (-60),
      `vcs-providers.md` (-24), the root `README.md` (-13) and `model-support.md` §6-§8. Every other
      doc in the "mixed" row was believed to have gained a pointer over unchanged prose, which is the
      two-parallel-full-accounts state rule 1 exists to end. Each section checked
      against the LIVE page before it is cut. All 24 mixed docs now open with a pointer and eight
      have been reduced (-1,186 lines, a 16% cut of the 7,386-line corpus). **This item was marked
      closed once with fourteen docs still carrying full prose under a fresh pointer, which is the
      exact state it exists to end**; that is recorded under
      [What "closed" got wrong the first time](#what-closed-got-wrong-the-first-time), because the
      mistake is repeatable and a checklist tick is what hid it. What remains is eleven docs, each
      with a named verdict in the per-doc table rather than an unassessed row.
- [x] 16. **Guard the relative links BETWEEN repo docs** ([#1884](https://github.com/kibertoad/cat-factory/pull/1884))**.** `scripts/check-doc-links.mjs` (detection
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
- [x] 17. **Decide who owns the MANIFEST FORMAT, because two reductions are parked on it.**
      ([cat-factory-website#25](https://github.com/kibertoad/cat-factory-website/pull/25) +
      [#1884](https://github.com/kibertoad/cat-factory/pull/1884)) A
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
- [x] 18. **Guard the repo → website links from the WEBSITE repo**
      ([cat-factory-website#25](https://github.com/kibertoad/cat-factory-website/pull/25)), which is
      the option item 14 did not consider. It rejected a checked-in page list for rotting in the deletion direction, and
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
- [x] 16b. **The CHANGELOG exclusion, revisited rather than left as a decision only the code
      states.** Item 16 excluded generated `CHANGELOG`s and carried 33 of the 43 dangling targets
      out of scope with them. Re-examined and KEPT, for a reason worth writing down once so it is
      not re-litigated: a changelog entry is a claim about what was true at a released version, and
      a link inside one is part of that claim. Re-pointing it at a file's new path would make the
      entry describe a repository layout that did not exist when the version shipped, which is
      falsifying a record to satisfy a link checker. The alternative considered and rejected was
      rewriting only the links whose TARGET still exists somewhere: that is worse, because it leaves
      a changelog whose links are silently a mix of contemporaneous and back-dated, with nothing
      marking which is which. The 33 stay dangling on purpose, and the guard says so at the site
      that skips them.
- [x] 19. **Land the two website destinations the previous phase assumed, and make the ordering rule
      an ACTION.** Slices 15i and 15j cut toward `extend/tool-servers.html` and
      `operate/debugging-a-run.html`; neither page existed, and the commit message asserted both
      did. The website repo's phase F wrote them, to the anchors this repo already deep-links rather
      than the other way round, since those anchors were chosen here before the pages existed.
      **What let it happen is not a missing guard**, and this is the part worth carrying forward.
      Item 18's crossing guard is weekly BY DESIGN, for the good reason recorded in the gotcha
      below, and it was written in the same pull request as the breakage, so its first scheduled run
      was still days away. Neither repository's pull-request CI can see the other, by construction.
      So the check is a person, and the rule is now phrased as something you DO: CLAUDE.md's
      staleness sweep says open the website pull request first and NAME it in this one's
      description, and load the page before linking it. An assertion that the page exists is what
      failed; opening the URL is what would not have.
- [x] 20. **Two live website pages had stopped describing the code, and the reduction pass is what
      found them.** ([cat-factory-website#28](https://github.com/kibertoad/cat-factory-website/pull/28))
      `extend/custom-gates.md` imported `wireProvider` / `isProviderWired` from
      `@cat-factory/kernel` and called them as module-level functions; neither is exported, because
      provider wiring moved to an app-owned `ProviderRegistry` instance the facade injects.
      `extend/custom-providers.md` passed `environmentProvider` to `buildNodeContainer` /
      `startLocal`; that option was removed when environment backends became a registry keyed by
      `kind`. A deployment author following either page got a type error, and in the second case the
      repo doc it links had said so in its own opening paragraph the whole time.
      **What this adds to the existing checks.** Item 14 asks whether a link RESOLVES. Item 17 and
      the reduction-findings section ask whether the page is DEEP enough. Neither asks whether the
      page is still TRUE, and nothing automatic can: `check-repo-links.mjs` resolved both pages and
      both headings, correctly, and a code fence is not a link. The check is the same person doing
      the same reading, with one more question: does the example still compile against the seam this
      doc describes. Where the answer is no, the repo doc is usually the one that is right, because
      it is the one a code change's own PR touches.
      **And the fix has to land on the SITE first**, which is the ordering rule doing exactly what
      it is for: the reduction that discovered the breakage could not land until the page it points
      at was correct, so #28 merged ahead of this pull request and is named in its description.
- [x] 21. **`kubernetes-topology.md`: the blocked reduction, unblocked** (219 → 65 lines;
      [cat-factory-website#29](https://github.com/kibertoad/cat-factory-website/pull/29)). 15q wrote
      down what the site owed rather than cutting toward a page that stopped at the connect form,
      and that list was the specification for `deploy/kubernetes-topology.md`: what runs where, the
      control-plane / data-plane split, why the run pod has no Service, the RBAC verbs, the egress
      set, the reaping backstop and sizing. What stayed here is exactly what 15q predicted would,
      plus one thing it did not name: the pod-proxy is a DESIGN property a change can remove
      silently (add a Service and nothing fails), so it keeps a line here as an invariant rather
      than as topology. Both mermaid diagrams went with the topology; the site has no mermaid
      renderer and adding a build dependency for two figures was not worth it, so the page carries
      the same content as a table plus a numbered walkthrough.
- [x] 22. **`document-sources.md`: the last "partly", and the staleness it turned up** (592 → 551
      lines across 15k and this). The two halves 15k left unread were user-visible behaviour written
      as implementation, and both went to `guide/issue-sources.md`: what a pasted reference resolves
      to, and who may connect a source versus who may attach one. What stayed is the pre-flight's
      four rules (a `null` `canonicalUrl` is an answer, `droppedScope` is never normalised, the
      closed reason vocabulary with its host-pinned claim order, and an unknown reason landing as
      `unchecked`), the two structural facts under the picker, and the planner's two-prompt shape.
      **The tier-split TABLE stays**, against the first instinct to cut it: `permissionMounts.test.ts`
      names this doc as the rationale its `MEMBER_TIER_WRITES` list points at, so the table is a
      coupling, and what the site gained is the persona account rather than the route map.
      The staleness is in the status note above.
- [ ] 23. **Close the initiative out.** The reduction pass is done and the tracker should become an
      ADR under `backend/docs/adr/` with the checklists dropped, per CLAUDE.md. Two things to do
      first, both of which this tracker warns about and neither of which is mechanical: re-derive
      the audit's "repo-only, no website page today" row against the live navigation rather than
      trusting the cell (it is empty today, and an empty one rots the same way a populated one
      does), and decide `local-kubernetes-setup-windows.md`, the one doc still classified
      "user-facing, unmoved" on the grounds that the Kubernetes page did not need it yet. Item 21
      changed that premise. The conversion also has to repoint every doc that links this tracker,
      since `git rm`ing it dangles them and the guard from item 16 is what will say which.

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

| Doc                               | Pointer | Reduced         | What it still owes                                                      |
| --------------------------------- | ------- | --------------- | ----------------------------------------------------------------------- |
| `model-support.md`                | yes     | yes (§6-§8)     | nothing                                                                 |
| `security-model.md`               | yes     | yes (-60)       | nothing                                                                 |
| `vcs-providers.md`                | yes     | yes (-24)       | nothing                                                                 |
| `custom-agents.md`                | yes     | yes (15a)       | nothing                                                                 |
| `environments-integration.md`     | yes     | yes (15b + 15e) | nothing: the manifest half went once item 17 landed                     |
| `runner-pool-integration.md`      | yes     | yes (15c)       | nothing: §3 is a pointer, 701 → 520 lines                               |
| `auth.md`                         | yes     | yes (15f)       | nothing                                                                 |
| `reusable-operations.md`          | yes     | yes (15g)       | nothing                                                                 |
| `figma-claude-design-context.md`  | yes     | yes (15h)       | nothing                                                                 |
| `mcp-tool-servers.md`             | yes     | yes (15i)       | nothing: 723 → 347, after the site gained a tool-servers page           |
| `debug-api.md`                    | yes     | yes (15j)       | nothing: 433 → 207, after the site gained a debugging-a-run page        |
| `document-sources.md`             | yes     | yes (15k + 22)  | nothing: 592 → 551, and the intro's provider list was stale             |
| `llm-telemetry.md`                | yes     | not needed      | nothing: the clean-split model to copy                                  |
| `storage-and-retention.md`        | yes     | not needed      | nothing: read, and it is sink/rollup design the site does not carry     |
| `reports.md`                      | yes     | not needed      | nothing: read, and it is the decision record behind the reports surface |
| `custom-agent-roles.md`           | yes     | yes (15l)       | nothing: 374 → 320                                                      |
| `custom-agent-gate-ergonomics.md` | yes     | yes (15l)       | nothing: 214 → 195                                                      |
| `custom-binary-stores.md`         | yes     | yes (15l)       | nothing: 129 → 99                                                       |
| `native-environment-adapter.md`   | yes     | yes (15m)       | nothing: 460 → 389, after the site's wiring section was FIXED           |
| `local-k3s-environments.md`       | yes     | yes (15o)       | nothing: 250 → 240, a small cut, and the assessment says why            |
| `initiative-presets.md`           | yes     | yes (15n)       | nothing: 328 → 236, after the site gained a preset-authoring page       |
| `github-integration.md`           | yes     | yes (15p)       | nothing: reduced toward ADR 0001, not toward the site                   |
| `github-operations.md`            | yes     | yes (15p)       | nothing: 188 → 71, the largest cut of the initiative                    |
| `kubernetes-topology.md`          | yes     | yes (item 21)   | nothing: 219 → 65, once the site gained a topology page                 |

**A verdict of "no reduction warranted" is a real outcome and it is not the same as "not
assessed".** `llm-telemetry.md`, `storage-and-retention.md` and `reports.md` were read against their
pages and keep everything: all three are design records (sink and rollup design, D1 constraints, the
decisions behind a reports surface) whose user-facing halves the site already owns in full.

No row says "not read" any more, and the two that carried debt longest are worth reading together:
both were BLOCKED on a page rather than unassessed, both stayed blocked for two phases, and both
were cleared in one website pull request once someone wrote down what the page owed. **Naming the
missing destination is what makes the debt cheap to pay; leaving the row as "not assessed" is what
made it expensive**, because the next pass has to re-derive the finding before it can act on it.

### What "closed" got wrong the first time

Item 15 was ticked with the five reductions listed above and fourteen docs carrying **unchanged
prose under a fresh pointer**. The numbers at that moment: five docs reduced by 614 lines, nine docs
grown by 40 (the pointer itself), and 1,139 lines of NEW website pages. The material had been
ADDED to the site rather than moved off the repo, which is two parallel full accounts with a link
between them: the precise failure rule 1 exists to prevent, re-made inside the slice written to end
it.

Three things let it happen, and each is a check worth running before ticking this item again:

- **A pointer is cheap and reads as progress.** Nine pointers in one change looks like nine docs
  handled. Count LINES REMOVED, not docs touched.
- **"Not assessed" was recorded as a state, and then counted as done.** It was honest in the table
  and invisible in the checkbox. A per-doc verdict is the unit; the checkbox may not lead it.
- **Growing the site is the easy half.** Writing a good page is satisfying and lands cleanly; cutting
  the doc it duplicates is fiddly, breaks inbound anchors, and is where the value is. The website PR
  merging first is the ordering rule, and it makes it structurally easy to stop after the easy half.

The follow-up pass that fixed it found the two biggest offenders were exactly the two docs nobody had
opened: `mcp-tool-servers.md` (723 lines against 65 on the site) and `debug-api.md` (433 against 25).
Both needed a new website page before anything could be cut, which is the same shape as item 17 and
is now the expected shape rather than a surprise: **where a repo doc is many times its page, the
reduction is blocked on a page that does not exist yet, and finding that out is the assessment.**

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

### 15i. `mcp-tool-servers.md`: DONE (723 → 347 lines)

**Correction, and it is the one this whole initiative is most embarrassed by: the page was NOT
written first.** This entry claimed `extend/tool-servers.md` was landed ahead of the cut and it was
not landed at all, so for the life of that gap the reduction pointed at a 404 and the material was
reachable from nowhere. The page exists now (item 19), written to the anchors this entry had already
committed to. The rest of this entry stands.

The largest single reduction of the initiative, and the clearest case of the pattern item 17 first
exposed: 723 lines here against 65 on the site, inside a subsection of the custom-agents page. The
reduction was blocked on a page that did not exist, and `extend/tool-servers.md` takes the whole
deployment-author path: registering, the harness support matrix, the
credential rules, OAuth end to end, the Test button's nine verdicts, operating a `stdio` server, the
security posture, the worked Slack runbook and the adoption checklist.

What stayed is the shape to copy for the remaining reductions. Not a summary of the page: a table of
WHERE each decision is resolved and why there, plus the four OAuth choices the obvious implementation
would get wrong (the redirect landing on the SPA rather than the backend, the sealed rather than
signed `state`, `secrets.manage` re-resolved at STORE time, and refusing the token endpoint's
redirects), plus the enforcement facts (three layers per floor, the two credential names of which
only one is a boundary, a deployment resolver replacing the chain for every subject).

One coupling the cut had to carry: the generated environment-variable page maps
`mcp-tool-servers.md` onto a site link through the website's `sync-env-vars.mjs`, and it pointed at
`custom-agents.html#skills-and-tool-servers`. Repointed at the new page and regenerated in the same
change, or the reference page would have kept sending readers to the section this slice thinned.

### 15j. `debug-api.md`: DONE (433 → 207 lines)

The same shape at a smaller scale: 433 lines against about 25 spread over two pages, with the whole
"Investigating a run" walkthrough (find it, follow the signal, grep for the cause, attribute the
spend, read the conversation, export the bundle) sitting here where a caller with an API key and no
checkout is exactly the reader. `operate/debugging-a-run.md` takes it, plus the endpoint table and
the size ceilings. Same correction as 15i: that page was landed by item 19, AFTER this cut rather
than before it.

Kept: the one design constraint every endpoint obeys (a response's size is computable BEFORE the
request), why the path is `/debug`, the auth model, where the code lives, and the mothership-mode
routing. Plus two things the site cannot state for itself: why a `trajectory` page is not derivable
from a `recent` one (`seq` restarts per dispatch and `jobId` sorts by agent-kind spelling), and why
each signal's SEVERITY is what it is (`tool_calls_failed` as an `info` because a failing tool call is
the ordinary shape of an agent loop).

### 15k. `document-sources.md`: PARTLY (592 → 588 lines), finished by item 22

The per-source connect instructions moved to the site's supported-sources table, and what stayed is
the two facts that are about this codebase: GitHub stores no per-workspace credential and resolves an
IMPLICIT connection, and its reads are tenant-scoped at the provider, which is a cross-tenant hole
with no other guard behind it.

**This one was honestly unfinished, and item 22 finished it.** The import/plan/spawn machinery and
the context picker's tier split were not read against the site, and the picker section in particular
was 30 lines of behaviour a user sees (what a member is shown versus an admin) written as
implementation. That description was accurate and it was the specification item 22 worked from,
which is the argument for writing a real verdict into an unfinished row rather than a checkbox.

`llm-telemetry.md` is the model of a clean split and needs nothing: every section is an internal rule
with no counterpart on the site. Copy its shape.

### 15l. The three capability docs: `custom-agent-roles`, `-gate-ergonomics`, `custom-binary-stores`

Rode together because each cut the same shape: a table or an example the site now carries in equal
or greater depth, with a fact underneath it that only makes sense with the code open.

- **`custom-agent-roles.md` (374 → 320).** The traits table went (the site's is LONGER: it carries
  `foundational-catalog`, `foundational-contracts` and `binary-output`), as did the
  `McpServerDefinition` / `secretKeys` / `oauth` field tables, which `extend/tool-servers.html`
  took in full at item 19. What stayed of the tool-server section is three facts about how the
  platform READS a declaration rather than how you write one, and the one the site genuinely does
  not carry is the `oauth` pair `resource` / `header`, where a `secretKeys` entry naming the same
  header is a boot WARNING and the granted token silently wins.
- **`custom-agent-gate-ergonomics.md` (214 → 195).** The `defineStructuredOutput` example and the
  authoring checklist both had longer counterparts on the site. What replaced the checklist is the
  one thing neither website page can state without knowing what validates when: the ORDER
  registrations must happen in.
- **`custom-binary-stores.md` (129 → 99).** The registration example and its four rules are the
  site's. The mothership two-process rule MOVED there rather than being deleted, because it is a
  deployment instruction and its absence is silent: register only on the nodes and the sweep reports
  the same zero it reports for a deployment that stores nothing.

### 15m. `native-environment-adapter.md` (460 → 389), and the reason it could not have been cut before

**This is the doc that found the breakage.** Its registration section opened by saying the
`buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })` singletons were
REMOVED and the seam is now the injected `EnvironmentBackendRegistry`. The website page it points at
taught the removed option, in a copy-pasteable example. The repo doc was right and had been right
since the change landed; nobody had read the two side by side.

So the cut is the second half of a fix, not a cut: `extend/custom-providers.html` gained the correct
wiring (phase G), and this doc reduced to the two facts that are about the SEAM rather than about
wiring one adapter (there is deliberately no provider injection option, because selection is a
per-workspace fact; and by-reference registration means module identity does not matter). The
`confirmTeardown` rules also moved to the site, because they are how you WRITE the probe; what
stayed is where the verdict goes and that omitting it is a supported choice recorded as
`unverifiable`.

### 15n. `initiative-presets.md` (328 → 236), and the destination nobody had

The site said, on `guide/initiatives.html`, that a deployment registers its own presets in code and
sent the reader to `extend/custom-agents.html`, which says nothing about presets.
`extend/reusable-operations.html` named the preset as one of four vehicles and sent them back to
`guide/initiatives.html`. Every link resolved. The reader who correctly picked the preset vehicle
was routed in a circle and landed nowhere, and no guard on either side can see that, because
nothing was broken: the material simply did not exist.

`extend/initiative-presets.html` is that page (phase G), and the reduction is against it: the seam,
the registration table, the form vocabulary, the `phaseTemplate` declaration, the human-review
override and the two worked examples all went. What stayed is what the ENGINE does: the two generic
mechanisms that ENFORCE a phase template (the planner prompt fold and the ingest normalizer, neither
of which knows a preset id), the descriptor's wire constraint, and the cross-phase-artifact rule,
which is the one thing in the file that decides an agent kind's SURFACE and would be re-derived
wrongly by anyone who did not know it.

**The lesson to carry: a circular cross-link is what a missing destination looks like.** Two pages
each named the other as the authority. When a page says "see X for how", open X and check that it
does, which is the same instruction item 19 arrived at from the other direction.

### 15o. `local-k3s-environments.md` (250 → 240): a small cut, deliberately

Only the guided-setup walkthrough went, because `deploy/kubernetes.html#local-k3s-guided-setup`
carries it in equal depth. The manual path, the RBAC manifest and the WSL2 networking notes stayed,
and the doc now says why: the manual path is a `kubectl apply` against a file THIS REPOSITORY ships,
so the reader is already in a checkout. A ten-line cut is the correct answer here, and recording it
as such is what stops the next pass re-opening the file expecting one.

### 15p. The GitHub pair: `github-operations.md` (188 → 71) and `github-integration.md`

The largest single cut of the initiative, and the easiest, because `deploy/github-app.html` already
owned the setup path in MORE depth than the runbook did: it carries the permission table with a
reason per row, the OAuth callback the runbook never mentioned, and the privileged-App opt-in for
programmatic repository creation. Sections 0 through 3 and 6 were a strictly worse copy. Five of the
eight troubleshooting rows were too.

What stayed is the production queue path, the deploy commands, rotation, and the three
troubleshooting rows whose diagnosis needs something only this side can see: the App JWT's claims,
the reconciliation cursor, the rate-limit ledger. The doc now states that test explicitly, so the
next person adding a row knows which table it belongs in.

**Two code remedies moved with the content**, per the slice-9 rule that a remedy whose instruction
the website now owns moves to `SITE_DOCS`. The `GITHUB_APP_PRIVATE_KEY` config problem (whose whole
remedy is the PKCS#8 conversion) and the node facade's "no GitHub token source" boot warning both
pointed at the runbook for a step that is no longer in it. `SITE_DOCS.githubApp` is the new entry.

`github-integration.md` is the one doc here reduced toward a SIBLING rather than the site: its "Why
a GitHub App (and not OAuth / PAT)" comparison restated ADR 0001's decision 1, in a file that names
ADR 0001 as "the design rationale" two paragraphs earlier. That is the repo-to-repo class this
tracker already names, and the rule it broke ("a doc that names another as the full model may not
also contain that model") is the same one `custom-agents.md` broke three times. Everything else in
the file (the ports, the services, the adapters, the auth crypto, the projection and cursor model,
the endpoint table) is contributor material with no counterpart on the site, so it stays whole.

### 15q. `kubernetes-topology.md`: READ, and BLOCKED. Cut by item 21, one phase later.

The one row that did not end in a reduction when it was written, and it was a verdict rather than a
deferral. Kept here because the verdict is what made item 21 cheap: the website page was written
from the list below without re-reading the doc.

`deploy/kubernetes.html` stops at the CONNECT FORM: which fields to fill on the Agent containers and
Test environments tabs. `kubernetes-topology.md` is the other question entirely, and by the reader
test it is the website's: an operator laying out namespaces, node pools, a `NetworkPolicy`, the
ServiceAccount's RBAC verbs, and sizing for concurrent runs needs every line of it and needs no
checkout. Today they can fill in the form and cannot lay out the cluster.

So this is the item-17 shape again, and the rule holds: the reduction is blocked on a page that does
not exist, and finding that out IS the assessment. What the website owes is a topology section on
its Kubernetes page (or a page beside it): the two backends and how they differ, who owns the
control plane versus the data plane, why the run pod has no Service and the RBAC-gated pod-proxy is
the only way in, the executor's egress set, and the reaping backstop a bare Pod needs. What would
stay here afterwards is small and specific: that a re-dispatch is a `409 AlreadyExists` treated as an
idempotent re-attach, why it is a bare Pod rather than a Job, and the manifest variant's
`jobId`-sticky routing.

**Not cutting it was the finding.** The previous phase cut two docs toward pages it had not opened;
the correct move when the page cannot receive the content is to write down what it owes and leave
the content where a reader can still reach it. Item 21 then paid it: the page owns every bullet in
the paragraph above, and what stayed is the small specific set the paragraph predicted.

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

- **Land the website page before the repo link to it, and LOAD it rather than believing you did.**
  A repo doc linking a 404 fails silently for every reader. This tracker's header obeys the first
  half; item 19 exists because a phase obeyed neither. The failure mode is specific and it is not
  laziness: a slice that WROTE a website page in its plan, and then reduced against that plan,
  reads its own intent as an accomplished fact, and every artefact it produces afterwards (the
  commit message, this tracker's own slice entry) repeats the claim rather than checking it. Two
  reduction entries here asserted a page was written first; neither page existed. **The check that
  works is opening the URL**, and the phrasing that survives is an action rather than an ordering:
  CLAUDE.md's sweep now says to open the website pull request first and NAME it in the repo one's
  description, which is a thing a reviewer can see the absence of.
- **A page can resolve, be deep enough, and still be WRONG.** The two Extend pages item 20 fixed
  passed every check this initiative had: they existed, their anchors resolved, and they carried
  more sections than the repo docs pointing at them. They also taught APIs that had been deleted.
  A code example is not a link, so no crossing guard can see it, and neither repository's CI can
  typecheck the other's prose. The practical rule: **when you reduce a doc toward a page, read the
  page's CODE, not only its coverage**, and when the two disagree about what exists, believe the
  repo doc, because it is the one a code change's own pull request has to touch.
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
