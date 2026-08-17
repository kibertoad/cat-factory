import type { AgentKind, DeclaredToolServers } from '@cat-factory/kernel'
import type { AgentKindRegistry } from './registry.js'
import type { normalizeSkillRefs } from './capabilities.js'

// ---------------------------------------------------------------------------
// Where the deployment-level CAPABILITY layer of the agent-kind registry is read from, when that
// is not this process's own registry (docs/initiatives/mothership-mode.md).
//
// An agent kind is half data and half CODE, and only the data half can cross a wire: its prompts
// can be functions, its `preOps`/`postOps` are backend TypeScript, and its structured-output
// parser is a schema object. So the KIND CATALOG stays node-local, exactly like task types and the
// pipeline registry, and for the same stated reason — the unit of distribution is the org package,
// and a run naming a kind this build lacks fails LOUDLY at admission.
//
// Its CAPABILITY layer is the part that does not fail loudly, and this port is for that half
// alone. `assignSkills` / `assignToolServers` attach a house playbook or an MCP server to a
// BUILT-IN kind (`coder`, `pr-reviewer`, `merger`), and both are pure data: a bundled skill is a
// `SKILL.md` payload, a tool server is a transport plus the NAME of a credential. A node one build
// behind — the normal state of running a mothership deployment — silently dispatches `coder`
// without the org's playbook, and nothing anywhere reports it: the agent simply does the work its
// own way, which reads exactly like an agent that considered the standard and moved on.
//
// This is why the rule here is a MERGE where its three siblings (`FoundationalBuiltinSource`,
// `BinaryGeneratorSource`, `PromptFragmentSource`) forbid one. Those replace a set the node also
// registers, so merging would let a stale local copy win by id over the authoritative one. Here
// the two halves are different things: the KIND's own declarations belong to the code that
// implements it and must stay with that code, while the ASSIGNMENTS are the deployment's layer on
// top. Unioning them is the same union `skillsFor` / `toolServersFor` already perform in-process,
// with the deployment's half read from the process that owns it.
// ---------------------------------------------------------------------------

/** One kind's capability DECLARATIONS, resolved to definitions (never raw registered ids). */
export interface AgentKindCapabilityView {
  kind: AgentKind
  /**
   * The kind's skills, already normalised into the bundled/catalog split the engine resolves.
   * Resolved on the SERVING side because a registered id means nothing to a reader that does not
   * hold the registry it was registered on.
   */
  skills: ReturnType<typeof normalizeSkillRefs>
  /** The kind's tool servers, resolved to definitions and deduplicated by server id. */
  toolServers: DeclaredToolServers
}

/**
 * The deployment's agent-kind capability layer, as the engine reads it.
 *
 * Deliberately ONE method returning the whole (small, bounded) set rather than a per-kind read:
 * the callers are a dispatch's skill resolution and its tool-server resolution, which want
 * different kinds at different moments, and a per-kind remote read would put a round trip on each.
 */
export interface AgentKindSource {
  capabilities(): Promise<AgentKindCapabilityView[]>
}

/**
 * The in-process source: this deployment's own registry, read directly. The default on every
 * facade that is not a mothership-mode node.
 */
export function registryAgentKindSource(registry: AgentKindRegistry): AgentKindSource {
  return { capabilities: async () => agentKindCapabilityViews(registry) }
}

/**
 * Project a registry's capability layer — the enumeration is `kindsWithCapabilities()`, NOT
 * `all()`, because assignment to a built-in kind is the commonest case and `all()` lists only
 * registered kinds.
 */
export function agentKindCapabilityViews(registry: AgentKindRegistry): AgentKindCapabilityView[] {
  return registry.kindsWithCapabilities().map((kind) => ({
    kind,
    skills: registry.skillsFor(kind),
    toolServers: registry.toolServersFor(kind),
  }))
}

/**
 * The capability declarations for ONE kind, merged from this build's registry and the
 * deployment's (possibly remote) layer, deduplicated by id.
 *
 * Order is local-first, which is the same precedence `skillsFor` gives a kind's own declarations
 * over what was assigned to it: a kind's playbooks are part of how its code works, so they are
 * applied first and an org assignment of the same id does not displace them.
 */
export function mergeKindCapabilities(
  local: AgentKindCapabilityView,
  org: AgentKindCapabilityView | undefined,
): AgentKindCapabilityView {
  if (!org) return local
  const bundledIds = new Set(local.skills.bundled.map((s) => s.id))
  const catalogIds = new Set(local.skills.catalog.map((s) => s.skillId))
  return {
    kind: local.kind,
    skills: {
      bundled: [
        ...local.skills.bundled,
        ...org.skills.bundled.filter((s) => !bundledIds.has(s.id)),
      ],
      catalog: [
        ...local.skills.catalog,
        ...org.skills.catalog.filter((s) => !catalogIds.has(s.skillId)),
      ],
      // Reported, not merged away: an id the SERVING registry could not resolve is a typo in the
      // org's own package, and the node's dispatch warn is where an operator running locally sees
      // it. Deduplicated so a kind registered on both sides reports it once.
      unknown: [...new Set([...local.skills.unknown, ...org.skills.unknown])],
    },
    toolServers: mergeDeclaredToolServers(local.toolServers, org.toolServers),
  }
}

/**
 * Union a kind's LOCAL tool-server declarations with the deployment-level layer, deduplicated by
 * server id with the local definition winning (the same precedence `toolServersFor` gives a kind's
 * own declaration over one assigned to it). No org layer ⇒ the local answer, unchanged.
 *
 * Extracted because a DISPATCH performs this union too, at two sites that resolve tool servers
 * independently (the container executor, and a consensus panel's withheld-server ceiling), and
 * each one that re-derived it drifted: one dropped the `unknown` half, the other never looked at
 * the org layer at all. The union is one rule, so it has one implementation.
 */
export function mergeDeclaredToolServers(
  local: DeclaredToolServers,
  org: DeclaredToolServers | undefined,
): DeclaredToolServers {
  if (!org) return local
  const serverIds = new Set(local.servers.map((server) => server.id))
  return {
    servers: [...local.servers, ...org.servers.filter((server) => !serverIds.has(server.id))],
    // Reported, not merged away: an id the resolving registry could not resolve is a typo in the
    // package that declared it, and this is the only channel that can name it.
    unknown: [...new Set([...local.unknown, ...org.unknown])],
  }
}
