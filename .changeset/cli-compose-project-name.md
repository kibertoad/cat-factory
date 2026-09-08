---
'@cat-factory/cli': minor
---

Give each scaffolded deployment its own Compose project, so two of them can no longer share a
Postgres container and database volume. `local/docker-compose.yml` now declares a `name:` derived
from the deployment directory (`--dir`, or the project name when it is omitted) plus a `-local`
suffix, instead of leaving Compose to default to the compose file's own `local/` directory, which
every deployment shares. Regenerating a deployment with `--force` under a different directory name
moves it to the new project and prints the project, volume and `docker compose -p <old> down` it
leaves behind, because the old container keeps holding the published Postgres port.

The Cloudflare Pages project in `frontend/wrangler.toml` is normalized separately: Pages takes
lowercase letters, digits and hyphens only, so an npm-valid name like `acme.site` or `my_app` was
producing a deploy target `wrangler pages deploy` refuses.

Postgres credentials read out of `DATABASE_URL` are now YAML-quoted and escaped for Compose's `${}`
interpolation, and the database name is URL-decoded like the credentials already were. A password
holding `$` was silently truncated in the container while `local/.env` kept the whole one, and one
holding `: `, `[`, `{` or `*` broke the compose file's parse.

Breaking for programmatic callers: `BootstrapInput` gains a required `composeProjectName`, and
`composeProjectNameFor(targetDir, fallback)` is exported to compute it the way `bootstrap()` does.
