import type {
  CustomManifestTypeRecord,
  CustomManifestTypeRepository,
  EnvironmentUserHandlerRecord,
  EnvironmentUserHandlerRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the per-service provision-type persistence (slice 1): the
// per-USER infra handler overrides (local mode) and the workspace-defined custom-manifest
// -type catalog. Each facade persists these in its own store — D1 (SQLite) on Cloudflare,
// Drizzle/Postgres on Node — so this suite drives the SAME upsert / list / remove
// assertions through whichever real repository a runtime hands it. A column mapped
// differently (notably the `manifest_id` '' ⇄ null sentinel in the composite primary key)
// fails a test instead of shipping. See docs/initiatives/per-service-provision-types.md.

function userHandler(
  overrides: Partial<EnvironmentUserHandlerRecord> &
    Pick<EnvironmentUserHandlerRecord, 'userId' | 'workspaceId' | 'provisionType'>,
): EnvironmentUserHandlerRecord {
  return {
    manifestId: null,
    engine: 'local-docker',
    providerId: 'prov',
    label: 'Local docker',
    baseUrl: 'http://localhost',
    handlerJson: JSON.stringify({ engine: 'local-docker', manifest: {} }),
    acceptsManifestId: null,
    secretsCipher: 'cipher',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function customType(
  overrides: Partial<CustomManifestTypeRecord> &
    Pick<CustomManifestTypeRecord, 'workspaceId' | 'manifestId'>,
): CustomManifestTypeRecord {
  return {
    label: 'Custom',
    acceptsInputHint: null,
    description: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link EnvironmentUserHandlerRepository} +
 * {@link CustomManifestTypeRepository} behave identically to the others. The factories
 * return repos over the runtime's real store; ids are unique per run so the shared
 * database stays isolated between cases.
 */
export function defineEnvironmentHandlersSuite(
  name: string,
  makeRepos: () => {
    userHandlers: EnvironmentUserHandlerRepository
    customTypes: CustomManifestTypeRepository
  },
): void {
  describe(`[${name}] per-service provision-type repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { u: `u-${tag}`, ws: `ws-${tag}` }
    }

    it("lists a user's overrides for a workspace, scoped out other workspaces", async () => {
      const { userHandlers } = makeRepos()
      const { u, ws } = ids()
      const other = `${ws}-other`
      await userHandlers.upsert(
        userHandler({
          userId: u,
          workspaceId: ws,
          provisionType: 'kubernetes',
          engine: 'remote-kubernetes',
          createdAt: 10,
        }),
      )
      await userHandlers.upsert(
        userHandler({ userId: u, workspaceId: ws, provisionType: 'docker-compose', createdAt: 20 }),
      )
      await userHandlers.upsert(
        userHandler({ userId: u, workspaceId: other, provisionType: 'kubernetes', createdAt: 30 }),
      )

      const list = await userHandlers.listByUserWorkspace(u, ws)
      expect(list.map((h) => h.provisionType).sort()).toEqual(['docker-compose', 'kubernetes'])
      // The other workspace is excluded.
      expect(
        (await userHandlers.listByUserWorkspace(u, other)).map((h) => h.provisionType),
      ).toEqual(['kubernetes'])
    })

    it('round-trips a custom override and the manifestId null sentinel', async () => {
      const { userHandlers } = makeRepos()
      const { u, ws } = ids()
      // A `custom` type pins a manifestId; a non-custom one leaves it null. Both must
      // coexist under the composite primary key (the '' sentinel keeps them distinct).
      await userHandlers.upsert(
        userHandler({
          userId: u,
          workspaceId: ws,
          provisionType: 'custom',
          manifestId: 'helm',
          engine: 'remote-custom',
          acceptsManifestId: 'helm',
        }),
      )
      await userHandlers.upsert(
        userHandler({
          userId: u,
          workspaceId: ws,
          provisionType: 'docker-compose',
          manifestId: null,
        }),
      )
      const list = await userHandlers.listByUserWorkspace(u, ws)
      const custom = list.find((h) => h.provisionType === 'custom')!
      expect(custom.manifestId).toBe('helm')
      expect(custom.acceptsManifestId).toBe('helm')
      const compose = list.find((h) => h.provisionType === 'docker-compose')!
      expect(compose.manifestId).toBeNull()
      expect(list).toHaveLength(2)
    })

    it('upsert replaces an existing override in place (same composite key)', async () => {
      const { userHandlers } = makeRepos()
      const { u, ws } = ids()
      await userHandlers.upsert(
        userHandler({
          userId: u,
          workspaceId: ws,
          provisionType: 'kubernetes',
          label: 'First',
          engine: 'local-k3s',
        }),
      )
      await userHandlers.upsert(
        userHandler({
          userId: u,
          workspaceId: ws,
          provisionType: 'kubernetes',
          label: 'Second',
          engine: 'remote-kubernetes',
          updatedAt: 2,
        }),
      )
      const list = await userHandlers.listByUserWorkspace(u, ws)
      expect(list).toHaveLength(1)
      expect(list[0]!.label).toBe('Second')
      expect(list[0]!.engine).toBe('remote-kubernetes')
    })

    it('removes a single override, honouring the manifestId discriminator', async () => {
      const { userHandlers } = makeRepos()
      const { u, ws } = ids()
      await userHandlers.upsert(
        userHandler({ userId: u, workspaceId: ws, provisionType: 'custom', manifestId: 'helm' }),
      )
      await userHandlers.upsert(
        userHandler({
          userId: u,
          workspaceId: ws,
          provisionType: 'custom',
          manifestId: 'terraform',
        }),
      )
      await userHandlers.remove(u, ws, 'custom', 'helm')
      const remaining = await userHandlers.listByUserWorkspace(u, ws)
      expect(remaining.map((h) => h.manifestId)).toEqual(['terraform'])
    })

    it('manages the workspace custom-manifest-type catalog (upsert/list/remove)', async () => {
      const { customTypes } = makeRepos()
      const { ws } = ids()
      await customTypes.upsert(
        customType({ workspaceId: ws, manifestId: 'helm', label: 'Helm', createdAt: 1 }),
      )
      await customTypes.upsert(
        customType({
          workspaceId: ws,
          manifestId: 'tf',
          label: 'Terraform',
          acceptsInputHint: 'HCL',
          createdAt: 2,
        }),
      )
      let list = await customTypes.listByWorkspace(ws)
      expect(list.map((t) => t.manifestId).sort()).toEqual(['helm', 'tf'])
      expect(list.find((t) => t.manifestId === 'tf')!.acceptsInputHint).toBe('HCL')

      // Upsert replaces the label in place.
      await customTypes.upsert(
        customType({ workspaceId: ws, manifestId: 'helm', label: 'Helm v2', updatedAt: 3 }),
      )
      list = await customTypes.listByWorkspace(ws)
      expect(list.find((t) => t.manifestId === 'helm')!.label).toBe('Helm v2')

      await customTypes.remove(ws, 'helm')
      expect((await customTypes.listByWorkspace(ws)).map((t) => t.manifestId)).toEqual(['tf'])
    })
  })
}
