import { describe, expect, it } from 'vitest'
import { serveMisconfigured } from '../src/server.js'

type NodeServer = ReturnType<typeof serveMisconfigured>

// When boot hits a `ConfigValidationError`, the Node facade's `start()` (and the local facade's
// `startLocal()`) serve the misconfiguration FALLBACK on the normal port instead of exiting, so the
// developer's SPA gets a dedicated error screen rather than a bare "can't reach the backend" panel.
// The shared response builder is unit-tested in @cat-factory/server; this pins the Node-facade glue
// only the assembled server exercises — that `serveMisconfigured` actually binds a reachable
// listener and answers the SPA's boot handshake. Mirrors the Worker's misconfigured-fallback spec
// (keep the runtimes symmetric). No Postgres needed — this path never opens a DB connection.

const PROBLEMS = [
  { key: 'DATABASE_URL', summary: 'Postgres connection string.', remedy: 'Set DATABASE_URL.' },
]

async function portOf(server: NodeServer): Promise<number> {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
  const addr = server.address()
  if (!addr || typeof addr !== 'object') throw new Error('server has no bound port')
  return addr.port
}

describe('Node misconfiguration fallback', () => {
  it('serves a reachable fallback that answers the boot handshake and stays live on /health', async () => {
    // PORT 0 → an ephemeral port so the test never collides with a real listener.
    const server = serveMisconfigured(PROBLEMS, { PORT: '0', HOST: '127.0.0.1' })
    try {
      const port = await portOf(server)
      const base = `http://127.0.0.1:${port}`

      const config = await fetch(`${base}/auth/config`)
      expect(config.status).toBe(200)
      const body = (await config.json()) as {
        enabled: boolean
        misconfigured?: { problems: { key: string }[] }
      }
      expect(body.enabled).toBe(false)
      expect(body.misconfigured?.problems.map((p) => p.key)).toEqual(['DATABASE_URL'])

      const health = await fetch(`${base}/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ status: 'misconfigured' })

      const other = await fetch(`${base}/workspaces`)
      expect(other.status).toBe(503)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })
})
