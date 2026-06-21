// Local-mode deployment entry point.
//
// This is the example *deployment* of the reusable @cat-factory/local-server library:
// the Node.js facade with agent jobs run as per-job local Docker containers and GitHub
// reached via a personal access token, so a developer can run the whole product on
// their own machine. It contains no logic of its own — it calls the library's
// `startLocal()`, which connects to the local Postgres (`DATABASE_URL`), runs the
// schema migration, boots pg-boss + the durable execution worker, and serves the
// shared Hono app.
//
// Configuration comes from the process environment (see `.env.example`); the scripts
// load a local `.env` via Node's native `--env-file-if-exists` flag. Node 24+ runs
// this TypeScript directly via built-in type stripping — no build step for this entry.
import { startLocal } from '@cat-factory/local-server'

startLocal().catch((err: unknown) => {
  console.error('failed to start cat-factory local server:', err)
  process.exit(1)
})
