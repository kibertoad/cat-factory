import type { SharedStack, SharedStackRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the shared-stack store (long-lived compose infra a per-PR
// consumer environment attaches to over an external network). CRUD + persistence are
// runtime-symmetric even though the bring-up is local-facade-only, so each facade persists
// the entity in its own store — D1 on Cloudflare, Drizzle/Postgres on Node. This suite drives
// the SAME insert → read → list → status-transition → delete assertions through whichever real
// repository a runtime hands it, so a JSON column ((de)serialised differently — compose files,
// env-file pairs, recipe steps, the health gate) or the `allow_host_commands` boolean mapped
// differently fails a test instead of shipping.

function stack(
  overrides: Partial<SharedStack> & Pick<SharedStack, 'id' | 'workspaceId'>,
): SharedStack {
  return {
    name: 'acme-shared-services',
    cloneUrl: 'https://github.com/acme/acme-shared-services.git',
    gitRef: 'main',
    composeFiles: ['docker-compose.yml', 'docker-compose.override.yml'],
    composeProfiles: ['backends', 'peer'],
    envFiles: [{ template: '.env.shared-dist', target: '.env.shared' }],
    managedNetworks: ['acme-net'],
    setupSteps: [
      {
        kind: 'compose-exec',
        name: 'users sync',
        service: 'mysql',
        command: ['bin/users', 'sync'],
      },
      { kind: 'wait-http', name: 'debezium up', url: 'http://localhost:8083/connectors' },
    ],
    healthGate: { kind: 'http', url: 'https://acme.local/health' },
    allowHostCommands: false,
    status: 'stopped',
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link SharedStackRepository} behaves identically to the others.
 * `makeRepo` returns a repository over the runtime's real store; ids are unique per run so
 * the shared database stays isolated.
 */
export function defineSharedStackSuite(name: string, makeRepo: () => SharedStackRepository): void {
  describe(`[${name}] shared stack repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, id: `ss-${tag}` }
    }

    it('round-trips a full stack by id and by list, preserving every JSON field', async () => {
      const repo = makeRepo()
      const { ws, id } = ids()
      const entity = stack({ id, workspaceId: ws })
      await repo.upsert(ws, entity)

      expect(await repo.get(ws, id)).toEqual(entity)
      expect(await repo.list(ws)).toEqual([entity])
    })

    it('round-trips the minimal shape (no networks / steps / gate, host commands on)', async () => {
      const repo = makeRepo()
      const { ws, id } = ids()
      const minimal = stack({
        id,
        workspaceId: ws,
        gitRef: null,
        composeFiles: ['compose.yaml'],
        composeProfiles: [],
        envFiles: [],
        managedNetworks: [],
        setupSteps: [],
        healthGate: null,
        allowHostCommands: true,
      })
      await repo.upsert(ws, minimal)
      expect(await repo.get(ws, id)).toEqual(minimal)
    })

    it('upsert overwrites in place — a status transition + lastError persists', async () => {
      const repo = makeRepo()
      const { ws, id } = ids()
      await repo.upsert(ws, stack({ id, workspaceId: ws }))

      const failed = stack({
        id,
        workspaceId: ws,
        status: 'failed',
        lastError: "Setup step 'users sync' failed: exit 1",
        updatedAt: 2,
      })
      await repo.upsert(ws, failed)

      const read = await repo.get(ws, id)
      expect(read!.status).toBe('failed')
      expect(read!.lastError).toBe("Setup step 'users sync' failed: exit 1")
      expect(await repo.list(ws)).toHaveLength(1)
    })

    it('scopes reads to a workspace and lists in creation order', async () => {
      const repo = makeRepo()
      const a = ids()
      const b = ids()
      await repo.upsert(a.ws, stack({ id: a.id, workspaceId: a.ws, createdAt: 1 }))
      await repo.upsert(a.ws, stack({ id: `${a.id}-2`, workspaceId: a.ws, createdAt: 2 }))
      await repo.upsert(b.ws, stack({ id: b.id, workspaceId: b.ws }))

      const listed = await repo.list(a.ws)
      expect(listed.map((s) => s.id)).toEqual([a.id, `${a.id}-2`])
      expect(await repo.get(a.ws, b.id)).toBeNull()
    })

    it('delete removes the entity', async () => {
      const repo = makeRepo()
      const { ws, id } = ids()
      await repo.upsert(ws, stack({ id, workspaceId: ws }))
      await repo.remove(ws, id)
      expect(await repo.get(ws, id)).toBeNull()
      expect(await repo.list(ws)).toEqual([])
    })
  })
}
