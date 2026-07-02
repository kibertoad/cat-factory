# `@cat-factory/cli` — the bootstrap CLI

`cat-factory init` scaffolds a local-mode deployment on the developer's machine (generates the
crypto secrets, mints a GitHub/GitLab PAT, writes the gitignored `.env` files). **Full usage:
[README.md](./README.md).**

Flat `src/`: pure functions (`buildPlan` / `generateSecrets` / `buildLocalEnv` / `mergeGitignore`
plus the VCS URL helpers) under an injectable IO+FS seam, so the whole flow is tested;
`@clack/prompts` is confined to the real IO impl.
