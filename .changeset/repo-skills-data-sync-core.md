---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/caching': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

feat: repo-sourced Claude Skills library — data + sync core (slice 1)

Land the persistence + sync foundation for the repo-sourced Claude Skills
initiative (docs/initiatives/repo-skills.md):

- New account-tier tables `skill_sources` + `account_skills` (D1 migration 0052
  ⇄ Drizzle schema + migration), with matching kernel ports
  (`SkillSourceRepository`, `AccountSkillRepository`) and both D1 and Drizzle
  repositories, asserted by a new cross-runtime conformance suite.
- A shared `repo-source-sync` helper extracted from the fragment library's sync
  mechanics (commit-pin-before-read, id-keyed tombstone sweep, invalidate-only-on-
  change, the status probe) plus a shared frontmatter parser; `FragmentSourceService`
  is refactored onto it, and the new `SkillSourceService` reuses it for the
  directory-per-skill (`<skill>/SKILL.md` + resources) sync unit.
- `SkillCatalogService` (the account skill-catalog read) backed by a new
  `AppCaches.skillCatalog` cache slice (pass-through on the Worker, like
  `fragmentCatalog`).
- Contracts + an account-scoped `SkillLibraryController` (list skills; link / list /
  sync / status / unlink sources), wired into all runtime facades. Opt-in behind the
  existing prompt-library flag.

`RepoContentEntry` gains an optional `size` (populated from the GitHub contents API)
so the skill resource manifest can record file sizes.
