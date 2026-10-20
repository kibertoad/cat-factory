import {
  type AgentKindCapabilityView,
  bundledSkillDefinitionSchema,
  catalogSkillRefSchema,
  exactly,
  mcpServerDefinitionSchema,
} from '@cat-factory/agents'
import type { DeclaredToolServers } from '@cat-factory/kernel'
import * as v from 'valibot'
import { isRecord } from '../shared/guards.js'

// The wire shape of `GET /internal/agent-kinds`, shared by the controller that encodes it and the
// `HttpAgentKindSource` that decodes it, so the two halves cannot drift.
//
// Every DEFINITION rides by reference: each distinct bundled skill and tool server is emitted once,
// in `bundledSkills` / `toolServers`, and each kind lists indexes into them. Inlined per kind, one
// large playbook assigned to several kinds serialised once per kind (the Nuxt UI capability is
// ~99 KB on three kinds), and this read runs on every mothership-mode dispatch.
//
// Deduplicated by CONTENT, not by id: nothing stops two kinds declaring different INLINE
// definitions under one id, and keying by id would silently hand one kind the other's playbook or
// server. An index rather than an id for the same reason.
//
// The reply carries an explicit `version`. A node refuses any version but its own as a named
// mismatch, so every LATER change to this shape names itself in both directions. The reply before
// this one had no version; see `decodeAgentKindLayer` for how it is read. A mothership and its
// nodes run the same build (`docs/initiatives/mothership-mode.md`).

/** The reply version this build encodes and the only one it decodes. Bump on any shape change. */
export const AGENT_KINDS_WIRE_VERSION = 2

/**
 * One kind's view on the wire: the domain view with each definition list replaced by indexes.
 * DERIVED from the domain types, so a field added to them rides through the encoder untouched and
 * fails to compile against {@link kindViewSchema} until the decoder reads it too.
 */
type AgentKindWireView = Omit<AgentKindCapabilityView, 'skills' | 'toolServers'> & {
  skills: Omit<AgentKindCapabilityView['skills'], 'bundled'> & { bundledRefs: number[] }
  toolServers: Omit<DeclaredToolServers, 'servers'> & { serverRefs: number[] }
}

const indexSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

const kindViewSchema = v.object({
  kind: v.string(),
  skills: v.object({
    bundledRefs: v.array(indexSchema),
    catalog: v.array(catalogSkillRefSchema),
    unknown: v.array(v.string()),
  }),
  toolServers: v.object({ serverRefs: v.array(indexSchema), unknown: v.array(v.string()) }),
})

const replySchema = v.object({
  version: v.literal(AGENT_KINDS_WIRE_VERSION),
  kinds: v.array(kindViewSchema),
  bundledSkills: v.array(bundledSkillDefinitionSchema),
  toolServers: v.array(mcpServerDefinitionSchema),
})

type AgentKindsWire = v.InferOutput<typeof replySchema>

exactly<v.InferOutput<typeof kindViewSchema>, AgentKindWireView>(true)

/** Encode a capability layer, emitting each distinct definition once. */
export function encodeAgentKindLayer(views: readonly AgentKindCapabilityView[]): AgentKindsWire {
  const skills = definitionTable<AgentKindsWire['bundledSkills'][number]>()
  const servers = definitionTable<AgentKindsWire['toolServers'][number]>()
  const kinds = views.map(
    ({
      skills: { bundled, ...skillsRest },
      toolServers: { servers: declared, ...serversRest },
      ...view
    }) => ({
      ...view,
      skills: { ...skillsRest, bundledRefs: bundled.map(skills.ref) },
      toolServers: { ...serversRest, serverRefs: declared.map(servers.ref) },
    }),
  )
  return {
    version: AGENT_KINDS_WIRE_VERSION,
    kinds,
    bundledSkills: skills.entries,
    toolServers: servers.entries,
  }
}

/**
 * A table that hands out one index per distinct definition, without serialising a body unless it
 * must. The same object always gets the same index (the registry returns one object per
 * registered id). A NEW object whose id no earlier entry has gets a new index straight away. Only
 * an object that shares its id with an earlier, different object is compared by content, which is
 * the inline-collision case the content dedup exists for.
 */
function definitionTable<T extends { id: string }>() {
  const entries: T[] = []
  const byIdentity = new Map<T, number>()
  const byId = new Map<string, number[]>()
  const contents = new Map<number, string>()
  const contentOf = (index: number): string => {
    let content = contents.get(index)
    if (content === undefined) {
      content = JSON.stringify(entries[index])
      contents.set(index, content)
    }
    return content
  }
  const ref = (definition: T): number => {
    const known = byIdentity.get(definition)
    if (known !== undefined) return known
    const sameId = byId.get(definition.id) ?? []
    let index: number | undefined
    if (sameId.length) {
      const content = JSON.stringify(definition)
      index = sameId.find((candidate) => contentOf(candidate) === content)
    }
    if (index === undefined) {
      index = entries.push(definition) - 1
      byId.set(definition.id, [...sameId, index])
    }
    byIdentity.set(definition, index)
    return index
  }
  return { entries, ref }
}

/** Why a reply could not be read: the field, what was wrong with it, and the definition it is in. */
export interface UnreadableAgentKindLayer {
  field: string
  issue: string
  definitionId?: string
}

/**
 * Decode a reply into complete per-kind views, or say why it cannot be read. Returns rather than
 * throws so the caller owns the refusal, which must be a throw: an unreadable reply is a capability
 * layer this node does not know, never an empty one.
 */
export function decodeAgentKindLayer(
  body: unknown,
):
  | { views: AgentKindCapabilityView[] }
  | { unreadable: UnreadableAgentKindLayer }
  | { versionMismatch: { received: unknown } } {
  if (!isRecord(body)) return { unreadable: { field: '(root)', issue: 'not a JSON object' } }
  if (body.version === undefined) return decodeUnversioned(body)
  // Named apart from a damaged reply because the fix is different: run the same build on both
  // sides, not look for corruption.
  if (body.version !== AGENT_KINDS_WIRE_VERSION) {
    return { versionMismatch: { received: body.version } }
  }
  const parsed = v.safeParse(replySchema, body)
  if (!parsed.success) return { unreadable: describeIssue(body, parsed.issues[0]) }
  const { kinds, bundledSkills, toolServers } = parsed.output
  const views: AgentKindCapabilityView[] = []
  for (const [position, { skills, toolServers: kindServers, ...view }] of kinds.entries()) {
    const { bundledRefs, ...skillsRest } = skills
    const bundled = dereference(bundledRefs, bundledSkills)
    if (typeof bundled === 'string') {
      return { unreadable: { field: `kinds.${position}.skills.bundledRefs`, issue: bundled } }
    }
    const { serverRefs, ...serversRest } = kindServers
    const servers = dereference(serverRefs, toolServers)
    if (typeof servers === 'string') {
      return { unreadable: { field: `kinds.${position}.toolServers.serverRefs`, issue: servers } }
    }
    views.push({
      ...view,
      skills: { ...skillsRest, bundled },
      toolServers: { ...serversRest, servers },
    })
  }
  return { views }
}

/**
 * The reply before `version` existed. An EMPTY `kinds` list is read as the empty layer it is: it
 * carries no definition to misread, and it is the stock product's reply, so a node updated before
 * its mothership keeps working there. A list whose every kind is in that reply's inline shape is a
 * named mismatch. Anything else is not a reply from any build, so it is unreadable, not a mismatch.
 */
function decodeUnversioned(
  body: Record<string, unknown>,
):
  | { views: [] }
  | { versionMismatch: { received: unknown } }
  | { unreadable: UnreadableAgentKindLayer } {
  if (Array.isArray(body.kinds) && body.kinds.length === 0) return { views: [] }
  if (Array.isArray(body.kinds) && body.kinds.every(isInlineShapeView)) {
    return { versionMismatch: { received: undefined } }
  }
  return { unreadable: { field: 'version', issue: 'missing, and the reply is in no known shape' } }
}

/** A kind entry in the shape a mothership sent before definitions rode by reference. */
function isInlineShapeView(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    isRecord(entry.skills) &&
    Array.isArray(entry.skills.bundled) &&
    isRecord(entry.toolServers) &&
    Array.isArray(entry.toolServers.servers)
  )
}

/**
 * Resolve one kind's indexes against a table, or say what is wrong. A reference past the end would
 * reach the harness as a definition with no body. Two references to one id would make the harness
 * write the same skill directory, or register the same MCP server name, twice: the in-process
 * normaliser never produces that, so the reply is damaged.
 */
function dereference<T extends { id: string }>(
  refs: readonly number[],
  table: readonly T[],
): T[] | string {
  const resolved: T[] = []
  const ids = new Set<string>()
  for (const index of refs) {
    const entry = table[index]
    if (entry === undefined)
      return `index ${index} is past the end of a ${table.length}-entry table`
    if (ids.has(entry.id)) return `references id "${entry.id}" twice`
    ids.add(entry.id)
    resolved.push(entry)
  }
  return resolved
}

/** The first schema issue as a field path, its message, and the id of the definition it is in. */
function describeIssue(
  body: Record<string, unknown>,
  issue: v.BaseIssue<unknown>,
): UnreadableAgentKindLayer {
  const field = v.getDotPath(issue) ?? '(root)'
  const [table, position] = (issue.path ?? []).map((item) => item.key)
  const definition =
    (table === 'bundledSkills' || table === 'toolServers') && typeof position === 'number'
      ? (body[table] as unknown[] | undefined)?.[position]
      : undefined
  const id = isRecord(definition) && typeof definition.id === 'string' ? definition.id : undefined
  return { field, issue: issue.message, ...(id ? { definitionId: id } : {}) }
}
