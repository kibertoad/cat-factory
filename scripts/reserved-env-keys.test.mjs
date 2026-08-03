// Fixtures for the reserved-env-key guard's two extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// A guard is the only thing stopping the hole it watches from reopening, so a silent regression in
// ITS logic disarms it while still reporting green — which this one has already demonstrated: an
// unanchored `reservedSpec` match read the PREFIX array twice (each list is named in the other's
// doc comment), so every exact name looked unreserved, and the fix could have gone the other way
// just as easily.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { documentedEnvVars, isReserved, reservedSpec } from './reserved-env-keys.mjs'

const DOC = `# Environment variables

| Variable                                            | Modes       | Default  | Description        |
| --------------------------------------------------- | ----------- | -------- | ------------------ |
| \`DATABASE_URL\`                                      | Node        | required | Postgres, not \`REDIS_URL\`. |
| \`PUBLIC_URL\` / \`WORKER_PUBLIC_URL\`                  | Node / CF   | derived  | Public base URL.   |
| \`LANGFUSE_*\`                                        | CF, Node    | none     | A whole family.    |

Prose mentioning \`SOME_OTHER_VAR\` outside a table is not a declaration.
`

test('takes every backticked name in the FIRST cell, including a multi-spelling row', () => {
  const names = documentedEnvVars(DOC)
  assert.ok(names.includes('DATABASE_URL'))
  assert.ok(names.includes('PUBLIC_URL'))
  assert.ok(names.includes('WORKER_PUBLIC_URL'))
})

test('reads a documented FAMILY as its bare stem', () => {
  assert.ok(documentedEnvVars(DOC).includes('LANGFUSE'))
})

test('ignores names outside the first cell — a Description column is prose, not a declaration', () => {
  // Reading later cells would reserve whatever a sentence happened to mention, and the guard's
  // whole claim is that the doc's first column IS the platform's variable inventory.
  const names = documentedEnvVars(DOC)
  assert.ok(!names.includes('REDIS_URL'))
  assert.ok(!names.includes('SOME_OTHER_VAR'))
})

const SOURCE = `
/**
 * See also {@link PLATFORM_RESERVED_ENV_KEYS} for the exact names.
 */
export const PLATFORM_RESERVED_ENV_PREFIXES: readonly string[] = ['AUTH_', 'GITHUB_']

/** Covered by no {@link PLATFORM_RESERVED_ENV_PREFIXES} family. */
export const PLATFORM_RESERVED_ENV_KEYS: readonly string[] = ['ENCRYPTION_KEY', 'PORT']
`

test('anchors each list on its DECLARATION, not on a mention in the other’s doc comment', () => {
  // The regression that shipped: an unanchored match found `PLATFORM_RESERVED_ENV_KEYS` inside
  // the prefixes' doc comment and read the prefix array as the key list.
  const spec = reservedSpec(SOURCE)
  assert.deepEqual(spec.keys, ['ENCRYPTION_KEY', 'PORT'])
  assert.deepEqual(spec.prefixes, ['AUTH_', 'GITHUB_'])
})

test('fails loudly when a list is no longer a plain literal, rather than reading half of one', () => {
  assert.throws(() => reservedSpec('export const PLATFORM_RESERVED_ENV_PREFIXES = computed()'))
})

test('matches an exact name, a prefix family, and a documented family stem', () => {
  const spec = reservedSpec(SOURCE)
  assert.equal(isReserved(spec, 'ENCRYPTION_KEY'), true)
  assert.equal(isReserved(spec, 'GITHUB_APP_PRIVATE_KEY'), true)
  // `GITHUB_*` is documented as the stem `GITHUB`; no variable is literally called that.
  assert.equal(isReserved(spec, 'GITHUB'), true)
  assert.equal(isReserved(spec, 'MESHY_API_KEY'), false)
})

test('matches case-insensitively, because `process.env` lookup does on Windows', () => {
  assert.equal(isReserved(reservedSpec(SOURCE), 'encryption_key'), true)
})
