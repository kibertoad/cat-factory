#!/usr/bin/env node
// Requires every HUMAN APPROVAL GATE raise in the engine to go through `buildStepApproval`.
//
// Why this is a guard and not a test: the invariant is "no site anywhere spells this as a
// literal", which a test in `@cat-factory/orchestration` cannot assert (the package is
// runtime-neutral and reads no filesystem), and which a behavioural test on the site that is
// already correct proves nothing about. What went wrong the first time was a COPY, so the check
// that matters is over the sources.
//
// The rule, the failure it prevents, and the two deliberate exclusions are documented in
// `gate-approval-raise.mjs`, which owns the detection and has fixtures in
// `gate-approval-raise.test.mjs` (`node --test 'scripts/*.test.mjs'`).
//
// Pure node, no install; runs in the always-on `repo-guards` CI job beside the other four.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findHandRolledApprovalRaises } from './gate-approval-raise.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCAN_DIR = join(ROOT, 'backend/packages/orchestration/src/modules/execution')

/** See `gate-approval-raise.mjs`: these raise the agent-decision parks, not the approval gate. */
const EXCLUDED = new Set(['RunStateMachine.ts'])

const offenders = []
for (const file of readdirSync(SCAN_DIR)) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts') || EXCLUDED.has(file)) continue
  const source = readFileSync(join(SCAN_DIR, file), 'utf8')
  for (const line of findHandRolledApprovalRaises(source)) {
    offenders.push(`${file}:${line}`)
  }
}

// The guard is only as good as its reach: if the builder stops being used at all, the scan above
// would pass on a codebase that had removed the very thing it enforces. So assert the positive
// too, naming the sites this exists to keep in step.
const users = readdirSync(SCAN_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .filter((f) => readFileSync(join(SCAN_DIR, f), 'utf8').includes('buildStepApproval('))
  .sort()
const EXPECTED_USERS = ['CompanionController.ts', 'RunDispatcher.ts', 'stepApproval.ts']

let failed = false
if (offenders.length) {
  failed = true
  console.error(
    'A human approval gate is raised as a hand-rolled object literal:\n' +
      offenders.map((o) => `  ${o}`).join('\n') +
      '\n\nUse `buildStepApproval(step, id, proposal)` so the gate carries the approver policy\n' +
      'and quorum the step configured. A literal silently drops both, and a gate that names its\n' +
      'approvers then resolves as though it named nobody. See `scripts/gate-approval-raise.mjs`.',
  )
}
if (users.join() !== EXPECTED_USERS.join()) {
  failed = true
  console.error(
    `Expected \`buildStepApproval\` in ${EXPECTED_USERS.join(', ')}, found ${
      users.join(', ') || '(none)'
    }.\nIf a raise site was added or removed on purpose, update EXPECTED_USERS in this guard.`,
  )
}
if (failed) process.exit(1)

console.log(
  `Every human approval gate raise goes through buildStepApproval (${users.length} sites).`,
)
