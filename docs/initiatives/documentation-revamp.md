# Documentation revamp: the repo ⇄ website split

Status: **proposal stage.** This PR lands the tracker only; no doc moves yet. The sibling
tracker for the website's own restructure lives in
[kibertoad/cat-factory-website `planning/documentation-revamp.md`](https://github.com/kibertoad/cat-factory-website/blob/main/planning/documentation-revamp.md),
and the two halves land coordinated slices (see the checklist).

## Goal and rationale

The platform has two documentation surfaces: this repo (the root `README.md`, `backend/docs/`,
`docs/`, package `README`s, `sdk/`) and the product site
[catfactory.ai](https://www.catfactory.ai/) (repo
[kibertoad/cat-factory-website](https://github.com/kibertoad/cat-factory-website)). No stated
rule decides which surface owns a topic, so three problems have accumulated:

- **User-facing material lives only in the repo.** `docs/environment-variables.md`,
  `docs/glossary.md`, `backend/docs/security-model.md`, `backend/docs/vcs-providers.md`,
  `backend/docs/debug-api.md`, `backend/docs/reports.md`, `sdk/README.md` and
  `sdk/mcp/README.md` all serve deployers, operators or integrators, none of whom should need
  a checkout to read them.
- **Several topics are documented twice**, once per surface, and each pair drifts
  independently: custom agents, the public API, model support, runner pools, ephemeral
  environments, the GitHub App.
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
     site as the long version.
5. **The staleness sweep covers the website.** The per-PR documentation sweep (CLAUDE.md)
   gains one question: does this change alter behaviour a website page describes? If yes, the
   PR says so, and the website repo's `sync-docs` pass (which reads this repo's commit
   history) picks it up.

## Current duplication and misplacement

The audit so far, to be completed by slice 1:

| Topic | Repo doc | Website page | Proposed authority |
| --- | --- | --- | --- |
| Custom agents | `backend/docs/custom-agents.md`, `custom-agent-roles.md`, `custom-agent-gate-ergonomics.md` | `deploy/custom-agents.md` | Website owns authoring how-to; repo keeps engine design (registries, the three stages). |
| Public API | `backend/docs/public-api.md` | `reference/public-api.md` | Website owns endpoint/scope/webhook usage; repo keeps the stability policy (ADR 0034) and the contracts → spec → SDK chain. |
| Model support | `backend/docs/model-support.md` | `guide/model-providers.md` | Website owns configuration and usage; repo keeps provisioning internals. Pilot slice. |
| Runner pools | `backend/docs/runner-pool-integration.md` | `deploy/runner-pools.md` | Website owns operating a pool; repo keeps the integration protocol. |
| Environments | `backend/docs/environments-integration.md`, `local-k3s-environments.md`, `kubernetes-topology.md` | `deploy/environments.md`, `deploy/kubernetes.md` | Website owns setup and operation; repo keeps provider integration design. |
| GitHub App | `backend/docs/github-integration.md`, `github-operations.md` | `deploy/github-app.md` | Website owns setup and the operations runbook; repo keeps integration design. |
| Repo-only today, user-facing | `docs/environment-variables.md`, `docs/glossary.md`, `backend/docs/security-model.md`, `backend/docs/vcs-providers.md`, `backend/docs/debug-api.md`, `backend/docs/reports.md`, `backend/docs/storage-and-retention.md`, `sdk/README.md`, `sdk/mcp/README.md` | none | Website gains the user-facing account (its tracker names the target section per doc); repo keeps internals where any remain. |

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

Each slice is a repo PR, a website PR, or a coordinated pair. Update with PR links as slices
land.

- [ ] 0. Trackers land: [#1847](https://github.com/kibertoad/cat-factory/pull/1847) and the
      website sibling
      [cat-factory-website#22](https://github.com/kibertoad/cat-factory-website/pull/22).
- [ ] 1. Classify every doc under `backend/docs/` and `docs/` as contributor / user-facing /
      mixed; record the outcome as a table in this tracker.
- [ ] 2. Pilot: model support (website absorbs usage; repo doc reduced to internals plus
      link).
- [ ] 3. Environment variables: the operator-facing reference moves to the website.
      `docs/environment-variables.md` is also the source `check-reserved-env-keys.mjs` reads,
      so this slice decides the mechanism: the file stays as the guard's authoritative list
      and the site renders from it, or the guard re-points.
- [ ] 4. Security model: user-facing summary on the website (extending its agent-isolation
      page); repo keeps the full trust-boundary doc.
- [ ] 5. Glossary: user-level vocabulary to the website; the repo glossary keeps the
      code-level naming map (dir ⇄ package names, internal seams).
- [ ] 6. SDKs and MCP: user docs to the website's extender section; `sdk/*/README.md` keep
      their package-shipped content self-contained.
- [ ] 7. Custom agents, gates, providers, frontend extensions: website owns authoring; repo
      docs reduced to engine design plus links.
- [ ] 8. VCS: GitHub App setup and operations to the website; the GitHub/GitLab support
      matrix (`vcs-providers.md`) to the website; repo keeps integration design.
- [ ] 9. Root README: shrink the Feature guide and Documentation index to the split model;
      each user-facing row links the website section.
- [ ] 10. State the model: `docs/README.md` and `CONTRIBUTING.md` gain the "where does a new
      doc go" rule; CLAUDE.md's staleness sweep gains the website question (rule 5 above).

## Gotchas

- **Land the website page before the repo link to it.** A repo doc linking a 404 fails
  silently for every reader.
- **The website restructure changes URLs.** Its tracker's phase A regroups navigation without
  moving files precisely so slices here can start early; slices that link moved pages wait
  for the website's redirect slice, or link section anchors that survive the move.
- **`check-shipped-doc-links.mjs`**: published package `README`s may not link repo-relative
  paths outside the package; website links from them must be absolute URLs.
- **`check-reserved-env-keys.mjs`** reads `docs/environment-variables.md`; slice 3 must keep
  the guard's source readable wherever the prose lands.
- **The website's `sync-docs` skill reads this repo's commit history.** A commit that removes
  or relocates a repo doc should say where the content went, so the sync pass re-links
  instead of re-importing deleted material.
