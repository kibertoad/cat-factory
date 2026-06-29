# @cat-factory/cli

## 0.2.0

### Minor Changes

- 5c95baa: Add `@cat-factory/cli` — a bootstrap CLI (`cat-factory init`) that scaffolds a local-mode
  deployment (Node/local backend + frontend SPA, mirroring `deploy/local` + `deploy/frontend` but
  on the published libraries). It generates the crypto secrets (`AUTH_SESSION_SECRET` hex,
  `ENCRYPTION_KEY` base64) in the server's required formats, mints a GitHub/GitLab personal access
  token by opening the browser at the right pre-scoped URL and reading the pasted value, and writes
  the populated `.env` files with a `.gitignore` that keeps them out of version control.
