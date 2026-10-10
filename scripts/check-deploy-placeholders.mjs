#!/usr/bin/env node
// Guards the deploy templates' placeholder invariant: `deploy/*`'s wrangler configs are
// TEMPLATES a reader copies, so a live line may not carry a real account id, resource id or
// hostname. The rules and the rationale live in `deploy-placeholders.mjs` (the testable
// detection half); this is the CLI that ci.yml's repo-guards job runs.
//
// This is the INVERSE of the "Guard deploy placeholders" step that existed while
// `deploy/backend` was a live deployment (that one refused a `REPLACE_WITH_` in a live
// binding; this one refuses everything BUT placeholders and example names).
//
// Usage:  node scripts/check-deploy-placeholders.mjs
// Exit 0 = clean; exit 1 = at least one template line carries a real identifier.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findLeakedIdentifiers } from './deploy-placeholders.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The two wrangler templates the docs make the placeholder promise about. The preview
// template is NOT listed: its `${...}` values are substituted by the preview workflow,
// which enforces its own rendered-config check.
const TEMPLATES = [
  'deploy/backend/wrangler.toml',
  'deploy/frontend/wrangler.toml',
  'deploy/gatekeeper/wrangler.toml',
]

let failed = false
for (const relPath of TEMPLATES) {
  const findings = findLeakedIdentifiers(readFileSync(resolve(root, relPath), 'utf8'))
  for (const { line, kind, token } of findings) {
    failed = true
    console.error(
      `${relPath}:${line}: ${kind} "${token}" in a live line. This file ships as a ` +
        `template: use a REPLACE_WITH_* placeholder or an example.com name.`,
    )
  }
}

if (failed) {
  process.exit(1)
}
console.log(`check-deploy-placeholders: ${TEMPLATES.length} templates, no real identifiers.`)
