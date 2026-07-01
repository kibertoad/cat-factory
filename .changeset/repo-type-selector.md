---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Add a repository-type selector to repo import and bootstrap. A frame can now be onboarded as
a backend service, a frontend app, a shared library, or a document repository. Document
repositories accept only document/spike tasks (enforced in `BoardService.addTask` and the
create-task form). New `library`/`document` block types, `frameRepoTypeSchema`/`FRAME_REPO_TYPES`
in contracts, and display metadata for the new types.
