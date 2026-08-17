import type { AgentKindCapabilityView, AgentKindSource } from '@cat-factory/agents'
import { UnavailableError, describeError } from '@cat-factory/kernel'

// The client half of the mothership-mode agent-kind CAPABILITY read (see
// `../modules/agentKinds/AgentKindsController.ts` for why only that half of the registry crosses
// the machine API). The fourth sibling of `foundationalBuiltins.ts`, `binaryGenerators.ts` and
// `promptFragments.ts`, written to the same contract for the same reason.

/**
 * An {@link AgentKindSource} backed by the mothership's `GET /internal/agent-kinds`, presenting the
 * node's machine token.
 *
 * **A failed read THROWS; it never degrades to an empty layer.** "The mothership is unreachable"
 * and "this deployment assigns no capabilities" are the same value and opposite facts, and the
 * second one is indistinguishable, at the agent, from a run that considered the org's playbook and
 * chose not to follow it. That covers every way the read can fail to produce the layer: a transport
 * error, a refusal, a 404 from a mothership older than this node, and a 200 whose payload this
 * client cannot read.
 *
 * Throwing is not the same as failing the run, and the caller decides which it becomes. A skill a
 * kind declared REQUIRED already fails its dispatch when it cannot be resolved, so the throw
 * reaching that path is the existing contract, not a new one; the tool-server side states an
 * unreachable layer to the agent the same way it states any capability it could not honour.
 *
 * There is no cache here on purpose, the same answer its three siblings give: the read happens once
 * per dispatch, behind the same per-dispatch resolution as the skills it feeds, and a second copy
 * of a value with no invalidation path is the homebrew cache the caching seam exists to keep out.
 */
export class HttpAgentKindSource implements AgentKindSource {
  constructor(
    private readonly opts: {
      baseUrl: string
      /**
       * The machine token to present, as a fixed string OR a provider read PER REQUEST, the same
       * shape `HttpPersistenceRpcClient` takes, so a token cached after boot by the
       * `/local/mothership/connect` login is picked up without a restart.
       */
      token: string | (() => string | null)
      fetchImpl?: typeof fetch
    },
  ) {}

  async capabilities(): Promise<AgentKindCapabilityView[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/internal/agent-kinds`
    let res: Response
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${token ?? ''}` } })
    } catch (error) {
      throw new UnavailableError(
        'The agent-kind capabilities could not be read from the mothership',
        'agent_kinds_unreachable',
        // Scrubbed through `redactSecrets`, because a fetch failure routinely echoes the request
        // URL, which here carries the mothership's address.
        describeError(error),
      )
    }
    if (!res.ok) {
      // Includes the case that matters most: a mothership OLDER than this node, which answers 404
      // for a route it does not serve. Reading that as "no assigned capabilities" is precisely the
      // silent-empty-layer failure this class refuses to produce.
      throw new UnavailableError(
        'The mothership refused the agent-kind capability read',
        'agent_kinds_unreachable',
        { status: res.status },
      )
    }
    const body = (await res.json().catch(() => null)) as { kinds?: unknown } | null
    // Shape-checked rather than cast, for the same reason every other failure here throws: a reply
    // this code cannot read is a reply whose capability layer is unknown, and the one disposition
    // that must never be reachable is answering an unknown layer with an empty one. An empty layer
    // is spelled `[]`, which no honest server omits.
    if (!body || !Array.isArray(body.kinds)) throw unreadable('kinds')
    // The ELEMENTS too, and shallowly enough to matter: an entry whose `kind` is not a string can
    // be matched against no dispatch, so a reply carrying one is a reply whose layer this node
    // cannot apply — the very thing this class promises never to answer quietly.
    if (!body.kinds.every(isCapabilityView)) throw unreadable('kinds[]')
    return body.kinds as AgentKindCapabilityView[]
  }
}

/** The shape one entry must have for a dispatch to be able to apply it. */
function isCapabilityView(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const { kind, skills, toolServers } = entry as {
    kind?: unknown
    skills?: unknown
    toolServers?: unknown
  }
  if (typeof kind !== 'string') return false
  const skillHalves = skills as { bundled?: unknown; catalog?: unknown; unknown?: unknown } | null
  if (
    !skillHalves ||
    !Array.isArray(skillHalves.bundled) ||
    !Array.isArray(skillHalves.catalog) ||
    !Array.isArray(skillHalves.unknown)
  ) {
    return false
  }
  const tools = toolServers as { servers?: unknown; unknown?: unknown } | null
  return Boolean(tools && Array.isArray(tools.servers) && Array.isArray(tools.unknown))
}

/**
 * The unreadable-reply refusal. One helper rather than two literals because they are one FACT (the
 * mothership answered with something this node cannot resolve a capability layer from), and the
 * whole point of this class is that every route to "we do not know the org's capabilities" ends at
 * a throw. `field` names which part failed.
 */
function unreadable(field: string): UnavailableError {
  return new UnavailableError(
    'The mothership returned an unreadable agent-kind capability layer',
    'agent_kinds_unreachable',
    { field },
  )
}
