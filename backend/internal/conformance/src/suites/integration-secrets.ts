import { createBackendRegistries } from '@cat-factory/integrations'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

export function defineSecretsConformance(harness: ConformanceHarness): void {
  describe('user secrets (per-user GitHub PAT)', () => {
    it('stores the secret system-encrypted, resolves it, and describes the kind — identically per store', async () => {
      const app = harness.makeApp()
      const probe = app.userSecrets?.()
      // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
      if (!probe) return
      const userId = `usr_secret_${Date.now()}`

      const stored = await probe.store(userId, 'github_pat', {
        secret: 'ghp_token_123',
        metadata: { apiBase: 'https://ghe.example/api/v3' },
      })
      expect(stored.kind).toBe('github_pat')
      expect(stored.hasSecret).toBe(true)
      expect(stored.metadata).toEqual({ apiBase: 'https://ghe.example/api/v3' })
      // The status never leaks the raw secret.
      expect(JSON.stringify(stored)).not.toContain('ghp_token_123')

      // The run-time resolve path (ResolveUserGitHubToken) decrypts the system-key secret.
      expect(await probe.resolve(userId, 'github_pat')).toBe('ghp_token_123')
      // Absent for another user.
      expect(await probe.resolve(`${userId}_other`, 'github_pat')).toBeNull()

      // The kind self-describes a single secret field + a connection test.
      const descriptor = probe.describe('github_pat')
      expect(descriptor?.supportsTest).toBe(true)
      expect(descriptor?.configFields.find((f) => f.secret)?.key).toBe('token')
    })

    it('resolves a deployment-registered custom kind through the injected app-owned registry — on every runtime', async () => {
      // The secret-kind registry is app-owned (no module-global Map): a deployment
      // registers a custom kind BY REFERENCE into the registry the harness injects via
      // `makeApp({ backendRegistries })`, so the facade's UserSecretService describes it
      // regardless of module identity — the migration's whole point. See
      // `docs/initiatives/registry-di-migration.md`.
      const backendRegistries = createBackendRegistries()
      backendRegistries.userSecretKindRegistry.register({
        kind: 'conformance-secret',
        label: 'Conformance secret',
        configFields: [{ key: 'token', label: 'Token', secret: true, required: true }],
      })
      const app = harness.makeApp(undefined, { backendRegistries })
      const probe = app.userSecrets?.()
      if (!probe) return

      // The injected custom kind is describable...
      const custom = probe.describe('conformance-secret')
      expect(custom?.kind).toBe('conformance-secret')
      expect(custom?.supportsTest).toBe(false)
      expect(custom?.configFields.find((f) => f.secret)?.key).toBe('token')
      // ...and the built-in still resolves off the SAME registry instance.
      expect(probe.describe('github_pat')?.supportsTest).toBe(true)
    })
  })

  describe('private package registries (per-workspace npm/GitHub-Packages auth)', () => {
    it('adds, lists redacted, resolves decrypted for dispatch, and removes — identically per store', async () => {
      const app = harness.makeApp()
      // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
      const probe = app.packageRegistries?.()
      if (!probe) return
      const { workspace } = await app.createWorkspace()
      const base = `/workspaces/${workspace.id}/package-registries`

      const empty = await app.call<{ entries: unknown[] }>('GET', base)
      expect(empty.status).toBe(200)
      expect(empty.body.entries).toEqual([])

      // Add one entry per vendor. The list view is REDACTED: vendor + scopes + token
      // tail only — the raw token must never appear on the wire.
      const added = await app.call<{
        entries: { id: string; vendor: string; scopes: string[]; tokenTail: string }[]
      }>('POST', base, {
        ecosystem: 'npm',
        vendor: 'npmjs',
        scopes: ['@acme'],
        token: 'npm_secret_token_1234',
      })
      expect(added.status).toBe(200)
      const listed = await app.call<{
        entries: { id: string; vendor: string; scopes: string[]; tokenTail: string }[]
      }>('POST', base, {
        ecosystem: 'npm',
        vendor: 'github-packages',
        scopes: ['@acme-internal', '@acme-tools'],
        token: 'ghp_registry_secret_5678',
      })
      expect(listed.status).toBe(200)
      expect(listed.body.entries).toHaveLength(2)
      const [npmjs, ghp] = listed.body.entries
      expect(npmjs?.vendor).toBe('npmjs')
      expect(npmjs?.scopes).toEqual(['@acme'])
      expect(npmjs?.tokenTail).toBe('1234')
      expect(ghp?.vendor).toBe('github-packages')
      expect(JSON.stringify(listed.body)).not.toContain('npm_secret_token_1234')
      expect(JSON.stringify(listed.body)).not.toContain('ghp_registry_secret_5678')

      // A second entry for an already-configured vendor is a 409: the harness renders one
      // host-keyed `_authToken` per registry, so a duplicate would be silently dropped.
      const dup = await app.call('POST', base, {
        ecosystem: 'npm',
        vendor: 'npmjs',
        scopes: ['@acme-extra'],
        token: 'npm_second_token_9999',
      })
      expect(dup.status).toBe(409)

      // A malformed scope is rejected at the write boundary.
      const bad = await app.call('POST', base, {
        ecosystem: 'npm',
        vendor: 'npmjs',
        scopes: ['not-a-scope!'],
        token: 'x_token_x',
      })
      expect(bad.status).toBeGreaterThanOrEqual(400)

      // The dispatch path decrypts the sealed entries and derives the vendor host —
      // this is what rides the container job body as `packageRegistries`.
      const dispatch = await probe.resolveForDispatch(workspace.id)
      expect(dispatch).toEqual([
        {
          ecosystem: 'npm',
          host: 'registry.npmjs.org',
          scopes: ['@acme'],
          token: 'npm_secret_token_1234',
        },
        {
          ecosystem: 'npm',
          host: 'npm.pkg.github.com',
          scopes: ['@acme-internal', '@acme-tools'],
          token: 'ghp_registry_secret_5678',
        },
      ])
      // A workspace with no connection dispatches nothing (no error).
      const other = await app.createWorkspace()
      expect(await probe.resolveForDispatch(other.workspace.id)).toEqual([])

      // Remove both entries; the second removal deletes the row outright.
      const firstId = listed.body.entries[0]?.id as string
      const secondId = listed.body.entries[1]?.id as string
      expect((await app.call('DELETE', `${base}/${firstId}`)).status).toBe(204)
      // Removing an unknown entry 404s rather than silently succeeding.
      expect((await app.call('DELETE', `${base}/${firstId}`)).status).toBe(404)
      expect((await app.call('DELETE', `${base}/${secondId}`)).status).toBe(204)
      const cleared = await app.call<{ entries: unknown[] }>('GET', base)
      expect(cleared.body.entries).toEqual([])
      expect(await probe.resolveForDispatch(workspace.id)).toEqual([])
    })
  })

  describe('sensitive per-service test credentials (sealed)', () => {
    it('seals values, lists redacted refs, and removes — identically per store', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace({ seed: true })
      // Key by a demo-board block (the inspector edits a service frame; CRUD is exact-keyed
      // by block id, so any seeded block id exercises the same store round-trip).
      const base = `/workspaces/${workspace.id}/services/blk_auth/test-secrets`

      const empty = await app.call<{ blockId: string; entries: unknown[] }>('GET', base)
      // Facades without ENCRYPTION_KEY don't wire the store; nothing to assert there.
      if (empty.status === 503) return
      expect(empty.status).toBe(200)
      expect(empty.body.entries).toEqual([])

      // Seal two secrets. The view is REDACTED: key + description only — the VALUE must
      // never appear on the wire (it is sealed at rest and delivered out of band).
      const set = await app.call<{
        blockId: string
        entries: { key: string; description: string }[]
      }>('PUT', base, {
        entries: [
          {
            key: 'STRIPE_API_KEY',
            description: 'Stripe test-mode secret key',
            value: 'sk_test_SECRET_VALUE_1',
          },
          {
            key: 'SENDGRID_TOKEN',
            description: 'SendGrid sandbox token',
            value: 'SG.SECRET_VALUE_2',
          },
        ],
      })
      expect(set.status).toBe(200)
      expect(set.body.entries.map((e) => e.key)).toEqual(['STRIPE_API_KEY', 'SENDGRID_TOKEN'])
      expect(JSON.stringify(set.body)).not.toContain('sk_test_SECRET_VALUE_1')
      expect(JSON.stringify(set.body)).not.toContain('SG.SECRET_VALUE_2')

      const listed = await app.call<{ entries: { key: string; description: string }[] }>(
        'GET',
        base,
      )
      expect(listed.status).toBe(200)
      expect(listed.body.entries).toEqual([
        { key: 'STRIPE_API_KEY', description: 'Stripe test-mode secret key' },
        { key: 'SENDGRID_TOKEN', description: 'SendGrid sandbox token' },
      ])
      expect(JSON.stringify(listed.body)).not.toContain('SECRET_VALUE')

      // A duplicate key is rejected at the write boundary (keys are unique per service).
      const dup = await app.call('PUT', base, {
        entries: [
          { key: 'STRIPE_API_KEY', description: 'a', value: 'x1' },
          { key: 'STRIPE_API_KEY', description: 'b', value: 'x2' },
        ],
      })
      expect(dup.status).toBeGreaterThanOrEqual(400)

      // A non-env-var key is rejected too.
      const badKey = await app.call('PUT', base, {
        entries: [{ key: '1-bad key', description: 'nope', value: 'x' }],
      })
      expect(badKey.status).toBeGreaterThanOrEqual(400)

      // A reserved/toolchain env-var name (would clobber the harness environment) is rejected
      // at the write boundary, not silently dropped at injection.
      const reserved = await app.call('PUT', base, {
        entries: [{ key: 'PATH', description: 'nope', value: 'x' }],
      })
      expect(reserved.status).toBeGreaterThanOrEqual(400)

      // Replacing with an empty set removes the row; the view is empty again.
      const cleared = await app.call<{ entries: unknown[] }>('PUT', base, { entries: [] })
      expect(cleared.status).toBe(200)
      expect(cleared.body.entries).toEqual([])
      expect((await app.call('DELETE', base)).status).toBe(204)
      expect((await app.call<{ entries: unknown[] }>('GET', base)).body.entries).toEqual([])
    })
  })
}
