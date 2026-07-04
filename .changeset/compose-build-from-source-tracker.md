---
---

Docs: add the `docs/initiatives/compose-build-from-source.md` tracker — the plan for an
opt-in build-from-source mode on the Docker Compose ephemeral-environment backend (clone the
PR head into a working tree, `docker compose build` + `up --wait`, mode-aware rejection that
still refuses `privileged` and host-escaping bind mounts). No code changes.
