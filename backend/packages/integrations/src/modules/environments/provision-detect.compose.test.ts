import { describe, expect, it } from 'vitest'
import { detectKubernetesProvisioning, detectSharedStack } from './provision-detect.logic.js'
import { makeReader, makeThrowingReader } from './test-support/provision-detect-readers.js'
import { RepoReadError } from './repo-read-error.js'

// The COMPOSE / stack-recipe half of the provisioning-detector suite: what a compose repo
// contributes to a recommendation (the `-f` override family, external networks, env/config
// templates, profiles, seed dumps, the repo-CLI hint) and the shared-stack detector that reads
// the same scan. Split from `provision-detect.logic.test.ts` along the same seam as the source
// (`provision-detect.compose.ts`); every test is unchanged.

// --- Stack recipes: compose-repo detection extensions (slice 2) ---------------------------------
describe('detectKubernetesProvisioning — stack recipes', () => {
  it('does NOT attach a recipe to a plain single-file compose repo', async () => {
    const reader = makeReader({ 'compose.yaml': 'services:\n  api:\n    image: nginx\n' })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('docker-compose')
    // Nothing recipe-shaped ⇒ no recipe, no recipe candidate arrays, no recipe notes.
    expect(rec.provisioning.recipe).toBeUndefined()
    expect(rec.composeFileCandidates).toBeUndefined()
    expect(rec.profileCandidates).toBeUndefined()
    expect(rec.seedDumpCandidates).toBeUndefined()
    expect(rec.repoCliHint).toBeUndefined()
  })

  it('layers a bare dev.yml base with its OS-specific overrides (acme docker/dev.yml shape)', async () => {
    const reader = makeReader({
      'docker/dev.yml': 'services:\n  app:\n    image: registry/app\n',
      'docker/dev.wsl.override.yml': 'services:\n  app: {}\n',
      'docker/dev.mac.override.yml': 'services:\n  app: {}\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.type).toBe('docker-compose')
    expect(rec.provisioning.composePath).toBe('docker/dev.yml')
    // Only the base is layered into the recipe; OS overrides are opt-in candidates.
    expect(rec.provisioning.recipe?.composeFiles).toEqual(['docker/dev.yml'])
    expect(rec.composeFileCandidates).toEqual([
      { path: 'docker/dev.yml', name: 'dev.yml', recommended: true },
      {
        path: 'docker/dev.mac.override.yml',
        name: 'dev.mac.override.yml',
        os: 'mac',
        recommended: false,
      },
      {
        path: 'docker/dev.wsl.override.yml',
        name: 'dev.wsl.override.yml',
        os: 'wsl',
        recommended: false,
      },
    ])
    expect(rec.notes.some((n) => n.field === 'composeFiles')).toBe(true)
  })

  it('layers a canonical compose file with its auto-merge override (both pre-selected)', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  api:\n    image: nginx\n',
      'compose.override.yaml': 'services:\n  api: {}\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.composePath).toBe('compose.yaml')
    expect(rec.provisioning.recipe?.composeFiles).toEqual(['compose.yaml', 'compose.override.yaml'])
    // A non-OS override is a base layer ⇒ both recommended, neither carries an `os`.
    expect(rec.composeFileCandidates).toEqual([
      { path: 'compose.yaml', name: 'compose.yaml', recommended: true },
      { path: 'compose.override.yaml', name: 'compose.override.yaml', recommended: true },
    ])
  })

  it('recommends external networks the compose file expects to pre-exist', async () => {
    const reader = makeReader({
      'compose.yaml':
        'services:\n  app:\n    image: nginx\n    networks: [acme-net]\nnetworks:\n  acme-net:\n    external: true\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.recipe?.externalNetworks).toEqual(['acme-net'])
    expect(rec.notes.some((n) => n.field === 'externalNetworks')).toBe(true)
    // A shared-stack binding is nudged (but no ref is fabricated — no stacks exist yet).
    expect(rec.notes.some((n) => n.field === 'sharedStackRefs')).toBe(true)
    expect(rec.provisioning.recipe?.sharedStackRefs).toBeUndefined()
  })

  it('resolves an external network name from external: { name }', async () => {
    const reader = makeReader({
      'compose.yaml':
        'services:\n  app:\n    image: nginx\nnetworks:\n  default:\n    external:\n      name: shared-bus\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.recipe?.externalNetworks).toEqual(['shared-bus'])
  })

  it('surfaces compose profiles default-off as opt-in candidates (never in the recipe)', async () => {
    const reader = makeReader({
      'compose.yaml':
        'services:\n  app:\n    image: nginx\n    profiles: [full]\n  peer:\n    image: cockroach\n    profiles: [peer, backends]\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    // Deduped + sorted, all opt-in (recommended:false).
    expect(rec.profileCandidates).toEqual([
      { profile: 'backends', recommended: false },
      { profile: 'full', recommended: false },
      { profile: 'peer', recommended: false },
    ])
    expect(rec.provisioning.recipe?.composeProfiles).toBeUndefined()
    expect(rec.notes.some((n) => n.field === 'composeProfiles')).toBe(true)
  })

  it('pairs committed env/config templates with their materialization targets', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      '.env.dev.local-dist': 'DATABASE_URL=\n',
      '.split.yaml.dist': 'flags: {}\n',
      '.env.example': 'API_KEY=\n',
      // A non-config template must NOT be treated as an env file.
      'README.dist': '# not an env file',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.recipe?.envFiles).toEqual([
      { template: '.env.dev.local-dist', target: '.env.dev.local' },
      { template: '.env.example', target: '.env' },
      { template: '.split.yaml.dist', target: '.split.yaml' },
    ])
    expect(rec.notes.some((n) => n.field === 'envFiles')).toBe(true)
  })

  it('surfaces SQL seed dumps (nested one level) as low-confidence candidates, fullest pre-selected', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      'deployment/acme-db-dummy/acme-dummy.sql': 'INSERT ...',
      'deployment/acme-db-dummy/acme-pre-dummy.sql': 'CREATE ...',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.seedDumpCandidates?.map((c) => c.path).sort()).toEqual([
      'deployment/acme-db-dummy/acme-dummy.sql',
      'deployment/acme-db-dummy/acme-pre-dummy.sql',
    ])
    // The full dummy dump outranks the "pre" (schema-ish) dump.
    const pick = rec.seedDumpCandidates?.find((c) => c.recommended)
    expect(pick?.path).toBe('deployment/acme-db-dummy/acme-dummy.sql')
    // Never auto-applied into the recipe — the wizard confirms.
    expect(rec.provisioning.recipe?.setupSteps).toBeUndefined()
    expect(rec.notes.some((n) => n.field === 'seedDump')).toBe(true)
  })

  it('flags a repo-CLI bring-up as a report-only hint (bin/*console* wins over a Makefile)', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      'bin/dev-console': '#!/usr/bin/env bash',
      Makefile: 'setup:\n\tdocker compose up',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.repoCliHint).toEqual({ path: 'bin/dev-console', kind: 'repo-cli' })
    expect(rec.notes.some((n) => n.field === 'repoCli')).toBe(true)
  })

  it('flags a Makefile bring-up when there is no repo CLI', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      Makefile: 'setup:\n\tdocker compose up',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.repoCliHint).toEqual({ path: 'Makefile', kind: 'makefile' })
  })

  // The pilot acceptance fixture: a acme-monolith-shaped complex compose repo (sanitized) exercising
  // every slice-2 extension at once — layered OS overrides, an external network, profiles, env-file
  // templates, a nested seed dump, and the repo's own imperative CLI.
  it('detects the full acme-monolith-shaped stack recipe end to end', async () => {
    const reader = makeReader({
      'docker/dev.yml':
        'services:\n' +
        '  app:\n' +
        '    image: registry/app\n' +
        '    profiles: [full]\n' +
        '    networks: [acme-net]\n' +
        '  cockroach:\n' +
        '    image: cockroachdb/cockroach\n' +
        '    profiles: [peer]\n' +
        'networks:\n' +
        '  acme-net:\n' +
        '    external: true\n',
      'docker/dev.wsl.override.yml': 'services:\n  app: {}\n',
      'docker/dev.mac.override.yml': 'services:\n  app: {}\n',
      '.env.dev.local-dist': 'DATABASE_URL=\n',
      '.split.yaml.dist': 'flags: {}\n',
      'deployment/acme-db-dummy/acme-dummy.sql': 'INSERT ...',
      'deployment/acme-db-dummy/acme-pre-dummy.sql': 'CREATE ...',
      'bin/dev-console': '#!/usr/bin/env bash',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.detected).toBe(true)
    expect(rec.provisioning.type).toBe('docker-compose')
    expect(rec.provisioning.composePath).toBe('docker/dev.yml')
    expect(rec.provisioning.recipe).toEqual({
      composeFiles: ['docker/dev.yml'],
      externalNetworks: ['acme-net'],
      envFiles: [
        { template: '.env.dev.local-dist', target: '.env.dev.local' },
        { template: '.split.yaml.dist', target: '.split.yaml' },
      ],
    })
    expect(
      rec.composeFileCandidates
        ?.filter((c) => c.os)
        .map((c) => c.os)
        .sort(),
    ).toEqual(['mac', 'wsl'])
    expect(rec.profileCandidates).toEqual([
      { profile: 'full', recommended: false },
      { profile: 'peer', recommended: false },
    ])
    expect(rec.seedDumpCandidates).toHaveLength(2)
    expect(rec.seedDumpCandidates?.find((c) => c.recommended)?.path).toBe(
      'deployment/acme-db-dummy/acme-dummy.sql',
    )
    expect(rec.repoCliHint).toEqual({ path: 'bin/dev-console', kind: 'repo-cli' })
  })

  it('does NOT detect a bare dev.yml that declares no services as docker-compose', async () => {
    // `dev.yml` is an ambiguous name (CLI / CI / Ansible config all use it); without a `services:`
    // map it must not be mistaken for a compose file.
    const reader = makeReader({ 'dev.yml': 'name: my-cli\ncommands:\n  build: make\n' })
    const rec = await detectKubernetesProvisioning(reader, { prefer: 'docker-compose' })
    expect(rec.detected).toBe(false)
    expect(rec.provisioning.type).toBe('infraless')
  })

  it('does NOT surface schema migrations under a migrations/ dir as seed dumps', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      'db/migrations/0001_init.sql': 'CREATE TABLE ...',
      'db/migrations/0002_add_data.sql': 'INSERT ...',
      // A real seed dump beside the migrations IS surfaced.
      'db/seed-data.sql': 'INSERT ...',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.seedDumpCandidates?.map((c) => c.path)).toEqual(['db/seed-data.sql'])
  })

  it('does NOT materialize a non-env config sample (values.yaml.example) as an env file', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      // A Helm values sample — a `.example` on a config file, NOT an env template.
      'values.yaml.example': 'replicas: 1\n',
      // A real env template IS materialized.
      '.env-dist': 'API_KEY=\n',
    })
    const rec = await detectKubernetesProvisioning(reader)
    expect(rec.provisioning.recipe?.envFiles).toEqual([{ template: '.env-dist', target: '.env' }])
  })

  it('picks the same env template regardless of directory-listing order (deterministic dedup)', async () => {
    const compose = 'services:\n  app:\n    image: nginx\n'
    // Both templates resolve to the same `.env` target — the dedup must not depend on listing order.
    const forward = await detectKubernetesProvisioning(
      makeReader({ 'compose.yaml': compose, '.env-dist': 'A=\n', '.env.example': 'A=\n' }),
    )
    const reverse = await detectKubernetesProvisioning(
      makeReader({ 'compose.yaml': compose, '.env.example': 'A=\n', '.env-dist': 'A=\n' }),
    )
    expect(forward.provisioning.recipe?.envFiles).toEqual([
      { template: '.env-dist', target: '.env' },
    ])
    expect(reverse.provisioning.recipe?.envFiles).toEqual(forward.provisioning.recipe?.envFiles)
  })

  // --- Universality: monorepo env-template depth + deployment-level convention extensions ---------

  it('detects env templates ONE LEVEL into monorepo service-container dirs', async () => {
    // The real pilot keeps its templates under `services/app/` (outside the compose dir); the
    // detector scans one level into services/apps/packages so they're still surfaced.
    const reader = makeReader({
      'docker/dev.yml': 'services:\n  app:\n    image: nginx\n',
      'services/app/.env.dev.local-dist': 'DATABASE_URL=\n',
      'apps/web/.env.example': 'API=\n',
      'packages/lib/README.md': 'not a template',
    })
    const rec = await detectKubernetesProvisioning(reader, { prefer: 'docker-compose' })
    // Sorted by template path (apps/… < services/…); deeper-than-one-level is NOT scanned.
    expect(rec.provisioning.recipe?.envFiles).toEqual([
      { template: 'apps/web/.env.example', target: 'apps/web/.env' },
      { template: 'services/app/.env.dev.local-dist', target: 'services/app/.env.dev.local' },
    ])
  })

  it('does NOT recognize a non-canonical compose name until conventions add it', async () => {
    const reader = makeReader({ 'stack.yml': 'services:\n  app:\n    image: nginx\n' })
    const without = await detectKubernetesProvisioning(reader, { prefer: 'docker-compose' })
    expect(without.detected).toBe(false)
    expect(without.provisioning.type).toBe('infraless')

    const withConv = await detectKubernetesProvisioning(reader, {
      prefer: 'docker-compose',
      conventions: { composeFiles: ['stack.yml'] },
    })
    expect(withConv.provisioning.type).toBe('docker-compose')
    expect(withConv.provisioning.composePath).toBe('stack.yml')
  })

  it('a convention-added name that is NOT a compose file (no services:) is still not detected', async () => {
    // A house name added via conventions is non-canonical, so — like the bare `dev.*` names — it is
    // only trusted as a compose file when it actually declares `services:`. Here `stack.yml` is an
    // unrelated app-config YAML (no `services:` map), so adding it as a convention must NOT make the
    // detector mistake it for a compose file.
    const reader = makeReader({ 'stack.yml': 'name: my-app\njobs:\n  - build\n' })
    const rec = await detectKubernetesProvisioning(reader, {
      prefer: 'docker-compose',
      conventions: { composeFiles: ['stack.yml'] },
    })
    expect(rec.detected).toBe(false)
    expect(rec.provisioning.type).toBe('infraless')
  })

  it('a canonical compose name still wins over a convention-added extra', async () => {
    const reader = makeReader({
      'compose.yaml': 'services:\n  app:\n    image: nginx\n',
      'stack.yml': 'services:\n  other:\n    image: redis\n',
    })
    const rec = await detectKubernetesProvisioning(reader, {
      prefer: 'docker-compose',
      conventions: { composeFiles: ['stack.yml'] },
    })
    expect(rec.provisioning.composePath).toBe('compose.yaml')
  })

  it('conventions extend the compose-dir / seed-dir / env-template-dir search', async () => {
    const reader = makeReader({
      'infra/compose.yaml': 'services:\n  app:\n    image: nginx\n',
      'ops/seed.sql': 'INSERT ...',
      'vault/.env-dist': 'TOKEN=\n',
    })
    // Default: compose lives under an unlisted dir, so nothing is found.
    const without = await detectKubernetesProvisioning(reader, { prefer: 'docker-compose' })
    expect(without.detected).toBe(false)

    const rec = await detectKubernetesProvisioning(reader, {
      prefer: 'docker-compose',
      conventions: {
        composeDirs: ['infra'],
        seedDirs: ['ops'],
        envTemplateDirs: ['vault'],
      },
    })
    expect(rec.provisioning.composePath).toBe('infra/compose.yaml')
    expect(rec.seedDumpCandidates?.map((c) => c.path)).toEqual(['ops/seed.sql'])
    expect(rec.provisioning.recipe?.envFiles).toContainEqual({
      template: 'vault/.env-dist',
      target: 'vault/.env',
    })
  })

  it('detectSharedStack honors the same convention extensions', async () => {
    const reader = makeReader({
      'stack.yml':
        'services:\n  db:\n    image: postgres\nnetworks:\n  shared-net:\n    external: true\n',
    })
    const without = await detectSharedStack(reader)
    expect(without.detected).toBe(false)

    const rec = await detectSharedStack(reader, { conventions: { composeFiles: ['stack.yml'] } })
    expect(rec.detected).toBe(true)
    expect(rec.composeFiles).toEqual(['stack.yml'])
    expect(rec.managedNetworks).toEqual(['shared-net'])
  })
})

describe('detectSharedStack', () => {
  it('detects a single self-contained compose (all reused deps inside) as the stack', async () => {
    const reader = makeReader({
      'docker-compose.yml': `
services:
  postgres:
    image: postgres:16
  redis:
    image: redis:7
  rabbitmq:
    image: rabbitmq:3
`,
    })
    const rec = await detectSharedStack(reader, { repoName: 'acme-shared-services' })
    expect(rec.detected).toBe(true)
    expect(rec.name).toBe('acme-shared-services')
    expect(rec.composeFiles).toEqual(['docker-compose.yml'])
    // A self-contained compose declares no external network — honest empty result.
    expect(rec.managedNetworks).toEqual([])
    expect(rec.composeProfiles).toEqual([])
    expect(rec.notes.some((n) => n.field === 'composeFiles' && n.confidence === 'high')).toBe(true)
  })

  it('detects external networks as managed networks + layers the override family', async () => {
    const reader = makeReader({
      'docker-compose.yml': `
services:
  mysql:
    image: mysql:8
    networks: [acme-net]
    profiles: [backends]
  cockroach:
    image: cockroachdb/cockroach
    profiles: [peer]
networks:
  acme-net:
    external: true
`,
      'docker-compose.override.yml': `
services:
  mysql:
    ports: ['3306:3306']
`,
    })
    const rec = await detectSharedStack(reader, { repoName: 'acme-shared-services' })
    expect(rec.detected).toBe(true)
    expect(rec.composeFiles).toEqual(['docker-compose.yml', 'docker-compose.override.yml'])
    expect(rec.managedNetworks).toEqual(['acme-net'])
    expect(rec.composeProfiles).toEqual(['backends', 'peer'])
    expect(rec.notes.some((n) => n.field === 'externalNetworks' && n.confidence === 'high')).toBe(
      true,
    )
  })

  it('surfaces env/config templates to materialize before up', async () => {
    const reader = makeReader({
      'compose.yaml': `
services:
  app:
    image: acme/app
`,
      '.env.shared-dist': 'FOO=bar',
    })
    const rec = await detectSharedStack(reader)
    expect(rec.detected).toBe(true)
    expect(rec.envFiles).toEqual([{ template: '.env.shared-dist', target: '.env.shared' }])
  })

  it('reads a compose file from a monorepo subdirectory', async () => {
    const reader = makeReader({
      'shared/docker-compose.yml': `
services:
  postgres:
    image: postgres:16
`,
    })
    const rec = await detectSharedStack(reader, { directory: 'shared' })
    expect(rec.detected).toBe(true)
    expect(rec.composeFiles).toEqual(['shared/docker-compose.yml'])
  })

  it('reports detected:false when the repo has no compose file', async () => {
    const reader = makeReader({ 'README.md': '# no compose here' })
    const rec = await detectSharedStack(reader)
    expect(rec.detected).toBe(false)
    expect(rec.composeFiles).toEqual([])
    expect(rec.notes[0]?.field).toBe('provisionType')
  })

  it('throws RepoReadError when the repo is unreadable rather than reporting "not found"', async () => {
    const reader = makeThrowingReader('GitHub GET /contents → 403: forbidden')
    await expect(detectSharedStack(reader)).rejects.toThrow(RepoReadError)
  })
})
