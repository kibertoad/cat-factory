#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { bootStdioServer, startupFailureMessage } from './stdio.ts'

// The `cat-factory-mcp` executable: the stdio server an MCP host spawns.
//
// Deliberately nothing but the process wiring: the environment, the filesystem, the stream every
// human-readable byte goes to (stderr, NEVER stdout, which carries the protocol), and the exit
// code. Everything it decides lives in `stdio.ts`, where a test can drive it.
//
// The `node:fs` import belongs to THIS file, the one module here that is a Node process by
// definition. The rest of the package is bundled into deployments' hosted endpoints (`http.ts`),
// including onto workerd, where the built-in does not resolve at build time.

bootStdioServer({
  env: process.env,
  log: (line) => process.stderr.write(line),
  readSecretFile: (path) => readFileSync(path, 'utf8'),
}).catch((error: unknown) => {
  process.stderr.write(startupFailureMessage(error))
  // Refusing to start is the point: a server that comes up without credentials would be listed by
  // the host as connected and would then fail every call, which costs a model several turns to work
  // out and reads to a user as the platform being broken.
  process.exit(1)
})
