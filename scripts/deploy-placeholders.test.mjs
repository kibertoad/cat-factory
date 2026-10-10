// Fixtures for the deploy-template placeholder guard. Run by `node --test 'scripts/*.test.mjs'`.
//
// The guard exists because the invariant it watches is promised in prose only (the root
// README, deploy/backend/README.md and the wrangler.toml headers), and the likeliest
// violation is the exact state the templates were scrubbed FROM: a maintainer's filled-in
// config committed back during real-deployment testing. Each fixture below is one of the
// identifier shapes that leak carried.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { findLeakedIdentifiers } from './deploy-placeholders.mjs'

const CLEAN = `name = "cat-factory-backend"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "cat_factory"
database_id = "REPLACE_WITH_cat_factory_DATABASE_ID"

[[containers]]
image = "registry.cloudflare.com/REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID/cat-factory-executor:1.94.0"

[vars]
WORKER_PUBLIC_URL = "https://cat-factory-backend.REPLACE_WITH_WORKERS_SUBDOMAIN.workers.dev"
GITHUB_API_BASE = "https://api.github.com"
AUTH_SUCCESS_REDIRECT_URL = "https://board.example.com"
LOCAL_URL = "http://localhost:8788"
`

test('a fully placeholder template is clean', () => {
  assert.deepEqual(findLeakedIdentifiers(CLEAN), [])
})

test('flags a real 32-hex account id, including inside an image ref', () => {
  const content =
    'image = "registry.cloudflare.com/fe0047c6a1b2c3d4e5f60718293a4b5c/cat-factory-executor:1.94.0"\n'
  const findings = findLeakedIdentifiers(content)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'account-id')
})

test('flags a real D1 database UUID', () => {
  const findings = findLeakedIdentifiers('database_id = "30748a59-7c3b-4d6e-9f10-2a3b4c5d6e7f"\n')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'resource-id')
})

test('flags a real workers.dev origin, which names the account subdomain', () => {
  const findings = findLeakedIdentifiers(
    'WORKER_PUBLIC_URL = "https://cat-factory.someones-subdomain.workers.dev"\n',
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'hostname')
  assert.equal(findings[0].token, 'cat-factory.someones-subdomain.workers.dev')
})

test('flags a custom hostname that is not an example name', () => {
  const findings = findLeakedIdentifiers('CORS_ALLOWED_ORIGINS = "https://board.somecompany.dev"\n')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'hostname')
})

test('comment lines are exempt: vendor documentation links live there', () => {
  const content =
    '# See https://developers.cloudflare.com/d1/ and account 0123456789abcdef0123456789abcdef\n'
  assert.deepEqual(findLeakedIdentifiers(content), [])
})

test('reports a 1-indexed line number the CI annotation can point at', () => {
  const content = 'name = "x"\n\ndatabase_id = "0123456789abcdef0123456789abcdef"\n'
  const findings = findLeakedIdentifiers(content)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].line, 3)
})

test('the templates in the tree are clean, so the guard passes on a fresh checkout', () => {
  // The guard's own acceptance: a failure here means either a real identifier landed in a
  // template or a rule above overreaches on a value the templates legitimately carry.
  for (const relPath of ['deploy/backend/wrangler.toml', 'deploy/frontend/wrangler.toml']) {
    const content = readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
    assert.deepEqual(
      findLeakedIdentifiers(content),
      [],
      `${relPath} should carry placeholders only`,
    )
  }
})
