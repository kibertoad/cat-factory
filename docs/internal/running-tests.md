# Running the tests locally

What it costs to get a green suite on a machine that is not a CI runner. Nothing here
is part of the product: it is the setup, the scope worth running per edit, and the two
traps that make a working tree look broken when the only thing missing is a database.

Kept SHORT and ratcheted (`scripts/check-file-size.mjs`) because `CLAUDE.md` points an
agent straight here. A pointer is only cheap while the thing it points at is: detail for
one package goes in that package's `AGENTS.md`, and anything a human contributor needs
before their first commit goes in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## The suites

`pnpm test:run` from the root covers every package, and it is CI's lane: running the
whole tree locally is BANNED (`CLAUDE.md`), so the scopes below are what you run. Most
of it needs no setup; two packages are the exception, the Node and Local facades, which
test against a real Postgres and with no server reachable fail with `DATABASE_URL is
required to run the local conformance tests` while every other task passes: read that
as "no database here", not as a broken merge. Not in `pnpm test:run` at all: Playwright
(`backend/internal/e2e`, needing Postgres and a browser) and mutation testing (nightly
CI only, see [`mutation-testing.md`](./mutation-testing.md)).

## Run a SCOPE, never the tree

The whole tree is minutes of wall clock and wants a database up, which is the wrong
price to pay per edit and the wrong thing to re-prove before a PR, since CI runs it on
every push. Two root scripts narrow it, and one of them is what you run instead:

- **`pnpm test:changed`**: the packages you changed plus everything depending on them
  (`--filter='...[origin/main]'`). The scope to iterate on. It carries `--env-mode=loose`
  because a kernel or server edit pulls the two Postgres facades in with it, and strict
  mode would then drop their `DATABASE_URL` (next section).
- **`pnpm test:quick`**: every package needing neither Postgres nor `workerd`, the same
  set CI runs as its `Test units (no DB)` lane, which
  `scripts/check-test-lane-parity.mjs` keeps true rather than merely asserted.

Both cap Turbo at half the cores: it fans out per package and each vitest then spawns
its own pool, so an unbounded run oversubscribes a small box badly enough to fail
timing-sensitive tests that pass on their own. Both also pass
`--output-logs=errors-only`, so a green run prints only Turbo's summary while a failing
package still prints its whole vitest output.

## Turbo does not hand `DATABASE_URL` to a task, so exporting it is not enough

`turbo.json` declares no `env` or `globalPassThroughEnv` for `test:run`, and Turbo's
default strict env mode filters out everything undeclared: the root `pnpm test:run`
reports the variable as missing however your shell is set. CI never hits this because
it does not run those two suites through Turbo at all (`pnpm --filter
@cat-factory/node-server exec vitest run`). Locally, either do the same or pass
`--env-mode=loose`:

```sh
export DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres
pnpm exec turbo run test:run --env-mode=loose \
  --filter=@cat-factory/node-server --filter=@cat-factory/local-server
```

## A failing task cancels its siblings, and a cancelled task looks like a failing one

Turbo stops the run when one task fails, so the others end with a bare
`[ELIFECYCLE] Command failed.` and no vitest summary above it. Only the package named
on Turbo's own `Failed:` line actually failed. Re-run anything else filtered and on its
own before diagnosing it. The scoped scripts above make this louder, not quieter: under
`--output-logs=errors-only` a cancelled sibling's bare line is all it prints.

Generation has the same shape of trap: `pnpm gen:openapi` reads
`backend/packages/contracts/dist`, so on a fresh checkout it dies with
`ERR_MODULE_NOT_FOUND` until `pnpm exec turbo run build --filter=@cat-factory/contracts`
(or a plain `pnpm build`) has run.

## A Postgres for those two suites

CI starts one in Docker via [`start-postgres.sh`](../../.github/scripts/start-postgres.sh),
which is the first thing to reach for. Where no Docker daemon is running (a Claude Code
web container is one such place), start a local cluster from the `postgres` package
instead:

```sh
export PGDATA=/var/tmp/cat-factory-pg
mkdir -p "$PGDATA" && chown postgres "$PGDATA"
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $PGDATA -U postgres --auth=trust"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -l $PGDATA/server.log \
  -o '-p 5433 -k /tmp' -w start"
```

Three things bite here. `-l` is not optional: without it the server inherits the
starting shell's stdout and holds it open, so `pg_ctl -w start` never returns and an
agent's own command times out with the server actually running. `initdb` and `pg_ctl`
refuse to run as root, so they run as the `postgres` user, which then has to be able to
traverse **every** directory above `$PGDATA`: a cluster inside a private per-session
scratch directory fails with `could not access directory ... Permission denied` until
each parent is `chmod o+x`, which is why the example puts it under `/var/tmp`. And the
harnesses create a database per vitest worker off the `postgres` maintenance database,
so `DATABASE_URL` has to name a superuser and must never point at a database you care
about.
