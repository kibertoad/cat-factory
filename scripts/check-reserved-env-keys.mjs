#!/usr/bin/env node
// Requires every environment variable the platform DOCUMENTS to be RESERVED — unavailable as a
// capability credential's key.
//
// The rule it protects: a tool server or a generative binary integration declares the credential
// it needs BY NAME, and the default resolver reads that name off the deployment's own
// environment. A definition names both the key it wants and the endpoint that key is sent to, so
// a declaration of `ENCRYPTION_KEY` is a registration that boots clean and ships the deployment's
// master sealing key into a prompt-injectable agent process. `isReservedPlatformEnvKey`
// (`backend/packages/contracts/src/reserved-env-keys.ts`) refuses those.
//
// This guard exists because that set is the one part of the design that can rot: prefix families
// cover most future variables automatically, but a new one outside them (`SOMETHING_URL`) would
// be resolvable the day it is added, silently, with nothing failing. The doc is where CLAUDE.md's
// documentation sweep already requires a new variable to be written down, so checking against it
// fails in the same PR — the only moment the reserved set can be updated without archaeology.
//
// The reverse direction is deliberately NOT checked: reserving MORE than the platform reads is
// free (nobody names an integration credential `PORT`), while reserving less is the hole.
//
// Usage:  node scripts/check-reserved-env-keys.mjs
// Exit 0 = clean; exit 1 = at least one documented variable is not reserved.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentedEnvVars, isReserved, reservedSpec } from './reserved-env-keys.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOC = join(root, 'docs', 'environment-variables.md')
const SPEC = join(root, 'backend', 'packages', 'contracts', 'src', 'reserved-env-keys.ts')

const spec = reservedSpec(readFileSync(SPEC, 'utf8'))
const documented = documentedEnvVars(readFileSync(DOC, 'utf8'))
const missing = documented.filter((name) => !isReserved(spec, name))

if (missing.length === 0) {
  console.log(
    `check-reserved-env-keys: ${documented.length} documented variables, all reserved ` +
      `(${spec.keys.length} exact names + ${spec.prefixes.length} prefix families).`,
  )
  process.exit(0)
}

console.error(
  `check-reserved-env-keys: ${missing.length} documented environment variable(s) are NOT reserved.\n` +
    `A capability credential (a tool server's, a generative integration's) could name one, and its\n` +
    `value would be read off the deployment's environment and injected into an agent process.\n`,
)
for (const name of missing) console.error(`  • ${name}`)
console.error(
  `\nFix: add each name to PLATFORM_RESERVED_ENV_KEYS in\n` +
    `  backend/packages/contracts/src/reserved-env-keys.ts\n` +
    `or, when it belongs to a family the platform owns, add that prefix to\n` +
    `PLATFORM_RESERVED_ENV_PREFIXES instead.`,
)
process.exit(1)
