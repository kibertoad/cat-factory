---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Service selection/deletion UX: browse the repo for the docker-compose path, configure
a new service inline, send the monorepo flag with the add request, and delete blocks
optimistically.

- **docker-compose path picker**: the service inspector's docker-compose field now has a
  "browse" button that opens the GitHub repo tree (the same navigator used for the monorepo
  directory picker, extracted into a reusable `RepoTreeBrowser`) so you pick the compose
  file directly instead of typing it. The path is stored relative to the repo root (the
  Tester runs `docker compose -f <path>` from the clone root), starting the browse inside
  the service's subdirectory for a monorepo service.
- **Configure a service while adding it**: after adding a service from a repo, the modal now
  shows the same configuration controls as the inspector (test infra + compose path +
  provider/size, and best-practice fragments) bound to the just-created service.
- **Monorepo flag travels with the add request**: flipping the "this is a monorepo" toggle
  is now modal-local and sent as part of `POST /blocks/from-repo` (`isMonorepo`) instead of
  persisting a separate up-front `PATCH`. The backend persists the flag when the service is
  added. The now-unused frontend `setMonorepo` action + API method are removed (the backend
  PATCH endpoint stays).
- **Optimistic deletion**: deleting a task, module, service, or recurring pipeline hides it
  immediately and only reappears — with an error toast — if the backend rejects the delete.
