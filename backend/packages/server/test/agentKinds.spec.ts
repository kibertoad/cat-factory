import { defaultAgentKindRegistry, mergeKindCapabilities } from '@cat-factory/agents'
import type { AgentKindCapabilityView } from '@cat-factory/agents'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { TOKEN_AUDIENCE, signerFor } from '../src/auth/signing.js'
import type { AppEnv } from '../src/http/env.js'
import { agentKindsController } from '../src/modules/agentKinds/AgentKindsController.js'
import { HttpAgentKindSource } from '../src/persistence/agentKinds.js'

/**
 * The mothership-mode agent-kind CAPABILITY read, end to end: the real client driving the real
 * controller over an in-process transport, the fourth sibling of `promptFragments.spec.ts` and
 * asserting the same properties, plus the one that is only true here — the layer MERGES with this
 * node's own registry rather than replacing it.
 *
 * What makes the merge the right rule (and the replacement rule wrong) is that the two halves are
 * different things: a kind's own declarations belong to the code implementing it, which never
 * crosses the wire, while `assignSkills`/`assignToolServers` are the deployment's layer on top.
 */

const SECRET = 'test-session-secret'

const PLAYBOOK = {
  id: 'org.review-playbook',
  name: 'review-playbook',
  description: 'How this org reviews code.',
  instructions: 'Read the diff twice.',
}

const TRACKER_SERVER = {
  id: 'org.tracker',
  transport: { kind: 'stdio' as const, command: 'tracker-mcp', args: [] },
}

/** The mothership: the real controller over a container carrying a real, populated registry. */
function mothership(populate: (registry: ReturnType<typeof defaultAgentKindRegistry>) => void) {
  const registry = defaultAgentKindRegistry()
  populate(registry)
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', {
      agentKindRegistry: registry,
      config: { auth: { sessionSecret: SECRET } },
    } as unknown as AppEnv['Variables']['container'])
    await next()
  })
  app.route('/', agentKindsController())
  return app
}

async function machineToken() {
  return signerFor(SECRET).sign({
    aud: TOKEN_AUDIENCE.machine,
    nodeId: 'node_1',
    userId: 'usr_1',
    scope: { accountIds: ['acc_1'] },
    exp: Date.now() + 60_000,
  })
}

/** The node: the real remote source, transported straight into the app above. */
async function node(app: Hono<AppEnv>, token?: string) {
  const resolved = token ?? (await machineToken())
  return new HttpAgentKindSource({
    baseUrl: 'https://mothership.test',
    token: resolved,
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      app.request(String(input), init)) as unknown as typeof fetch,
  })
}

/** A source over a fixed 200 payload, for the replies no real controller would produce. */
function sourceOver(payload: unknown) {
  return new HttpAgentKindSource({
    baseUrl: 'https://mothership.test',
    token: 'tok',
    fetchImpl: (() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch,
  })
}

describe('mothership-mode agent-kind capability layer', () => {
  it('serves what a deployment ASSIGNED to a built-in kind, which `all()` would not list', async () => {
    // The commonest shape by far, and the one an enumeration over registered kinds misses: nobody
    // re-registers `coder`, they attach the org's playbook to it.
    const source = await node(
      mothership((registry) => {
        registry.registerSkill(PLAYBOOK)
        registry.assignSkills('coder', [PLAYBOOK.id])
        registry.assignToolServers('coder', [TRACKER_SERVER])
      }),
    )
    const views = await source.capabilities()
    expect(views).toHaveLength(1)
    expect(views[0]!.kind).toBe('coder')
    expect(views[0]!.skills.bundled).toEqual([PLAYBOOK])
    expect(views[0]!.toolServers.servers.map((s) => s.id)).toEqual([TRACKER_SERVER.id])
  })

  it('resolves registered ids SERVER-side, because an id means nothing to the reader', async () => {
    // The node holds neither the bundled-skill map nor the tool-server map the ids were registered
    // in, so a wire carrying `'org.review-playbook'` would be unresolvable there.
    const source = await node(
      mothership((registry) => {
        registry.registerSkill(PLAYBOOK)
        registry.registerToolServer(TRACKER_SERVER)
        registry.assignSkills('pr-reviewer', [PLAYBOOK.id])
        registry.assignToolServers('pr-reviewer', [TRACKER_SERVER.id])
      }),
    )
    const [view] = await source.capabilities()
    expect(view!.skills.bundled[0]!.instructions).toBe(PLAYBOOK.instructions)
    expect(view!.toolServers.servers[0]!.transport).toEqual(TRACKER_SERVER.transport)
  })

  it('reports a deployment that assigns NONE as empty, which is the stock product', async () => {
    const source = await node(mothership(() => {}))
    await expect(source.capabilities()).resolves.toEqual([])
  })

  it('refuses the route without a machine token', async () => {
    expect((await mothership(() => {}).request('/internal/agent-kinds')).status).toBe(403)
  })

  it('refuses a token of the wrong audience (a user session can never be replayed here)', async () => {
    const session = await signerFor(SECRET).sign({
      aud: TOKEN_AUDIENCE.session,
      userId: 'usr_1',
      exp: Date.now() + 60_000,
    })
    const res = await mothership(() => {}).request('/internal/agent-kinds', {
      headers: { authorization: `Bearer ${session}` },
    })
    expect(res.status).toBe(403)
  })

  it('THROWS rather than reporting an empty layer when the read is refused', async () => {
    const source = await node(
      mothership(() => {}),
      'not-a-token',
    )
    await expect(source.capabilities()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'agent_kinds_unreachable' },
    })
  })

  it('THROWS when the mothership does not serve the route at all (an older build)', async () => {
    const source = await node(new Hono<AppEnv>())
    await expect(source.capabilities()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'agent_kinds_unreachable', status: 404 },
    })
  })

  it('THROWS on a well-formed 200 whose payload it cannot read', async () => {
    for (const payload of [
      {},
      { kinds: 'nope' },
      { kinds: [{ skills: { bundled: [], catalog: [], unknown: [] } }] },
      { kinds: [{ kind: 'coder', skills: {}, toolServers: { servers: [], unknown: [] } }] },
      { kinds: [{ kind: 'coder', skills: { bundled: [], catalog: [], unknown: [] } }] },
    ]) {
      await expect(sourceOver(payload).capabilities()).rejects.toMatchObject({
        code: 'unavailable',
        details: { reason: 'agent_kinds_unreachable' },
      })
    }
  })

  it('THROWS on a transport failure, with the cause scrubbed onto the details', async () => {
    const source = new HttpAgentKindSource({
      baseUrl: 'https://mothership.test',
      token: 'tok',
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    })
    await expect(source.capabilities()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'agent_kinds_unreachable' },
    })
  })
})

describe('mergeKindCapabilities', () => {
  const view = (over: Partial<AgentKindCapabilityView> = {}): AgentKindCapabilityView => ({
    kind: 'coder',
    skills: { bundled: [], catalog: [], unknown: [] },
    toolServers: { servers: [], unknown: [] },
    ...over,
  })

  it('unions the two halves, LOCAL first', async () => {
    // Precedence mirrors `skillsFor`, which applies a kind's OWN declarations before what was
    // assigned to it: its playbooks are part of how its code works.
    const local = view({
      skills: { bundled: [{ ...PLAYBOOK, id: 'local' }], catalog: [], unknown: [] },
    })
    const org = view({ skills: { bundled: [PLAYBOOK], catalog: [], unknown: [] } })
    expect(mergeKindCapabilities(local, org).skills.bundled.map((s) => s.id)).toEqual([
      'local',
      PLAYBOOK.id,
    ])
  })

  it('deduplicates by id so a kind registered on BOTH sides applies its skill once', async () => {
    const both = view({ skills: { bundled: [PLAYBOOK], catalog: [], unknown: [] } })
    expect(mergeKindCapabilities(both, both).skills.bundled).toHaveLength(1)
  })

  it('deduplicates tool servers by id, and keeps the LOCAL definition', async () => {
    const local = view({ toolServers: { servers: [TRACKER_SERVER], unknown: [] } })
    const org = view({
      toolServers: {
        servers: [{ ...TRACKER_SERVER, transport: { kind: 'stdio', command: 'other', args: [] } }],
        unknown: [],
      },
    })
    const merged = mergeKindCapabilities(local, org).toolServers.servers
    expect(merged).toHaveLength(1)
    expect(merged[0]!.transport).toEqual(TRACKER_SERVER.transport)
  })

  it('carries an UNRESOLVED id through rather than dropping it', async () => {
    // An id neither registry could resolve is a typo in somebody's package. It is reported at the
    // serving side's boot and warned about at dispatch; swallowing it here would leave a local
    // operator with a kind that silently applies one fewer playbook than its author wrote.
    const merged = mergeKindCapabilities(
      view({ skills: { bundled: [], catalog: [], unknown: ['ghost'] } }),
      view({ skills: { bundled: [], catalog: [], unknown: ['ghost', 'other'] } }),
    )
    expect(merged.skills.unknown).toEqual(['ghost', 'other'])
  })

  it('is the identity when no org layer answered for the kind', async () => {
    const local = view({ skills: { bundled: [PLAYBOOK], catalog: [], unknown: [] } })
    expect(mergeKindCapabilities(local, undefined)).toBe(local)
  })
})
