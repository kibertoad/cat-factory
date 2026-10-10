import type { AgentKindCapabilityView, BundledSkillDefinition } from '@cat-factory/agents'

// The wire shape of `GET /internal/agent-kinds`, shared by the controller that encodes it and the
// `HttpAgentKindSource` that decodes it, so the two halves cannot drift.
//
// A bundled skill rides BY REFERENCE: each unique definition is emitted once in `bundledSkills`,
// and each kind's `skills.bundledRefs` lists indexes into it. Inlined per kind, one large playbook
// assigned to several kinds serialised once per kind (the Nuxt UI capability is ~99 KB on three
// kinds), and this read runs on every mothership-mode dispatch.
//
// Deduplicated by CONTENT, not by id: nothing stops two kinds declaring different INLINE
// definitions under one id, and keying by id would silently hand one kind the other's playbook.
// An index rather than an id for the same reason.
//
// The field is RENAMED (`bundledRefs`, not `bundled`) on purpose. A node one build behind its
// mothership is normal, and an older node checks only that `skills.bundled` is an array: an array
// of indexes would pass that check and reach the harness as skills with no body. Under the new name
// the older node finds no `bundled` array and refuses the reply as unreadable, which is loud.

/** One kind's capability view with its bundled skills replaced by indexes into `bundledSkills`. */
export interface AgentKindWireView extends Omit<AgentKindCapabilityView, 'skills'> {
  skills: Omit<AgentKindCapabilityView['skills'], 'bundled'> & { bundledRefs: number[] }
}

/** The `GET /internal/agent-kinds` reply body. */
export interface AgentKindsWire {
  kinds: AgentKindWireView[]
  bundledSkills: BundledSkillDefinition[]
}

/** Encode a capability layer, emitting each distinct bundled skill once. */
export function encodeAgentKindLayer(views: readonly AgentKindCapabilityView[]): AgentKindsWire {
  const bundledSkills: BundledSkillDefinition[] = []
  const indexByContent = new Map<string, number>()
  const indexOf = (definition: BundledSkillDefinition): number => {
    const content = JSON.stringify(definition)
    let index = indexByContent.get(content)
    if (index === undefined) {
      index = bundledSkills.push(definition) - 1
      indexByContent.set(content, index)
    }
    return index
  }
  const kinds = views.map(({ skills: { bundled, ...rest }, ...view }) => ({
    ...view,
    skills: { ...rest, bundledRefs: bundled.map(indexOf) },
  }))
  return { kinds, bundledSkills }
}

/**
 * Decode a reply into complete per-kind views, or name the FIELD that could not be read. Returns
 * rather than throws so the caller owns the refusal, which must be a throw: an unreadable reply is
 * a capability layer this node does not know, never an empty one.
 */
export function decodeAgentKindLayer(
  body: unknown,
): { views: AgentKindCapabilityView[] } | { unreadable: string } {
  const { kinds, bundledSkills } = (body ?? {}) as { kinds?: unknown; bundledSkills?: unknown }
  if (!Array.isArray(kinds)) return { unreadable: 'kinds' }
  if (!Array.isArray(bundledSkills)) return { unreadable: 'bundledSkills' }
  // The ELEMENTS too, and shallowly enough to matter: an entry whose `kind` is not a string can be
  // matched against no dispatch, so a reply carrying one is a reply whose layer this node cannot
  // apply.
  if (!kinds.every(isWireView)) return { unreadable: 'kinds[]' }
  // A reference past the end would resolve to `undefined` and reach the harness as a skill with no
  // body, so it is refused here with the rest of the unreadable replies.
  const views: AgentKindCapabilityView[] = []
  for (const {
    skills: { bundledRefs, catalog, unknown },
    ...view
  } of kinds) {
    const bundled = bundledRefs.map((index) => bundledSkills[index] as unknown)
    if (!bundled.every(isBundledSkill)) return { unreadable: 'kinds[].skills.bundledRefs' }
    views.push({ ...view, skills: { bundled, catalog, unknown } })
  }
  return { views }
}

/** The shape one entry must have for a dispatch to be able to apply it. */
function isWireView(entry: unknown): entry is AgentKindWireView {
  if (!entry || typeof entry !== 'object') return false
  const { kind, skills, toolServers } = entry as {
    kind?: unknown
    skills?: unknown
    toolServers?: unknown
  }
  if (typeof kind !== 'string') return false
  const skillHalves = skills as {
    bundledRefs?: unknown
    catalog?: unknown
    unknown?: unknown
  } | null
  if (
    !skillHalves ||
    !Array.isArray(skillHalves.bundledRefs) ||
    !skillHalves.bundledRefs.every(Number.isInteger) ||
    !Array.isArray(skillHalves.catalog) ||
    !Array.isArray(skillHalves.unknown)
  ) {
    return false
  }
  const tools = toolServers as { servers?: unknown; unknown?: unknown } | null
  return Boolean(tools && Array.isArray(tools.servers) && Array.isArray(tools.unknown))
}

function isBundledSkill(entry: unknown): entry is BundledSkillDefinition {
  if (!entry || typeof entry !== 'object') return false
  const { id, instructions } = entry as { id?: unknown; instructions?: unknown }
  return typeof id === 'string' && typeof instructions === 'string'
}
