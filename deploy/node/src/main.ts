// Node.js service deployment entry point.
//
// This is the example *deployment* of the reusable @cat-factory/node-server library.
// It contains no logic of its own: it calls the library's `start()`, which connects
// to Postgres (`DATABASE_URL`), runs the schema migration, boots pg-boss + the durable
// execution worker, and serves the shared Hono app over `@hono/node-server`.
//
// Configuration comes from the process environment. The package scripts load a local
// `.env` via Node's NATIVE `--env-file-if-exists` flag (no dotenv dependency); in
// production, inject the same variables through your orchestrator's environment.
//
// Node 24+ runs this TypeScript directly via built-in type stripping — no build step
// for this entry (the library itself ships compiled `dist`). To run your own
// deployment, swap the workspace dependency in package.json for the published version,
// e.g. "@cat-factory/node-server": "^1.0.0".
import { start } from '@cat-factory/node-server'

start().catch((err: unknown) => {
  console.error('failed to start cat-factory node server:', err)
  process.exit(1)
})
