import type { AgentKindCapabilityView, BundledSkillDefinition } from '@cat-factory/agents'
import type { McpServerDefinition } from '@cat-factory/kernel'
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
// The per-kind fields are RENAMED (`bundledRefs`, `serverRefs`) on purpose. An older node checks
// only that `skills.bundled` and `toolServers.servers` are arrays, so an array of indexes under the
// old name would reach the harness as definitions with no body. Under the new names an older node
// refuses the reply as unreadable, which is loud. A mothership and its nodes therefore run the
// same build (`docs/initiatives/mothership-mode.md`).

/** One kind's capability view with every definition replaced by an index into the reply's tables. */
interface AgentKindWireView {
  kind: AgentKindCapabilityView['kind']
  skills: Omit<AgentKindCapabilityView['skills'], 'bundled'> & { bundledRefs: number[] }
  toolServers: { serverRefs: number[]; unknown: string[] }
}

/** The `GET /internal/agent-kinds` reply body. */
interface AgentKindsWire {
  kinds: AgentKindWireView[]
  bundledSkills: BundledSkillDefinition[]
  toolServers: McpServerDefinition[]
}

/** Encode a capability layer, emitting each distinct definition once. */
export function encodeAgentKindLayer(views: readonly AgentKindCapabilityView[]): AgentKindsWire {
  const skills = definitionTable<BundledSkillDefinition>()
  const servers = definitionTable<McpServerDefinition>()
  const kinds = views.map(({ kind, skills: { bundled, catalog, unknown }, toolServers }) => ({
    kind,
    skills: { bundledRefs: bundled.map(skills.ref), catalog, unknown },
    toolServers: { serverRefs: toolServers.servers.map(servers.ref), unknown: toolServers.unknown },
  }))
  return { kinds, bundledSkills: skills.entries, toolServers: servers.entries }
}

/**
 * A table that hands out one index per distinct definition. The identity map answers the common
 * case (the registry returns the same object for a registered id) without serialising the body;
 * the content key only runs for an object it has not seen.
 */
function definitionTable<T extends object>() {
  const entries: T[] = []
  const byIdentity = new Map<T, number>()
  const byContent = new Map<string, number>()
  const ref = (definition: T): number => {
    const known = byIdentity.get(definition)
    if (known !== undefined) return known
    const content = JSON.stringify(definition)
    let index = byContent.get(content)
    if (index === undefined) {
      index = entries.push(definition) - 1
      byContent.set(content, index)
    }
    byIdentity.set(definition, index)
    return index
  }
  return { entries, ref }
}

/**
 * Decode a reply into complete per-kind views, or name the FIELD that could not be read. Returns
 * rather than throws so the caller owns the refusal, which must be a throw: an unreadable reply is
 * a capability layer this node does not know, never an empty one.
 */
export function decodeAgentKindLayer(
  body: unknown,
): { views: AgentKindCapabilityView[] } | { unreadable: string } | { versionMismatch: true } {
  const { kinds, bundledSkills, toolServers } = (body ?? {}) as {
    kinds?: unknown
    bundledSkills?: unknown
    toolServers?: unknown
  }
  if (!Array.isArray(kinds)) return { unreadable: 'kinds' }
  // Named apart from a corrupt reply because the fix is different: this node is newer than its
  // mothership, and the remedy is to run the same build on both, not to look for damage. Both
  // tables missing IS the older shape, whatever `kinds` holds: the stock product's empty layer
  // (`{ kinds: [] }`) is the commonest reply an older mothership sends.
  if (bundledSkills === undefined && toolServers === undefined) return { versionMismatch: true }
  if (!Array.isArray(bundledSkills) || !bundledSkills.every(isBundledSkill)) {
    return { unreadable: 'bundledSkills' }
  }
  if (!Array.isArray(toolServers) || !toolServers.every(isToolServer)) {
    return { unreadable: 'toolServers' }
  }
  // The ELEMENTS too, and shallowly enough to matter: an entry whose `kind` is not a string can be
  // matched against no dispatch, so a reply carrying one is a reply whose layer this node cannot
  // apply.
  if (!kinds.every(isWireView)) return { unreadable: 'kinds[]' }
  // A reference past the end would resolve to `undefined` and reach the harness as a definition
  // with no body, so it is refused here with the rest of the unreadable replies.
  const views: AgentKindCapabilityView[] = []
  for (const { kind, skills, toolServers: kindServers } of kinds) {
    const bundled = dereference(skills.bundledRefs, bundledSkills)
    if (!bundled) return { unreadable: 'kinds[].skills.bundledRefs' }
    const servers = dereference(kindServers.serverRefs, toolServers)
    if (!servers) return { unreadable: 'kinds[].toolServers.serverRefs' }
    views.push({
      kind,
      skills: { bundled, catalog: skills.catalog, unknown: skills.unknown },
      toolServers: { servers, unknown: kindServers.unknown },
    })
  }
  return { views }
}

/** Resolve indexes against a table, or null when one points past its end. */
function dereference<T>(refs: readonly number[], table: readonly T[]): T[] | null {
  const resolved: T[] = []
  for (const index of refs) {
    const entry = table[index]
    if (entry === undefined) return null
    resolved.push(entry)
  }
  return resolved
}

/** The shape one entry must have for a dispatch to be able to apply it. */
function isWireView(entry: unknown): entry is AgentKindWireView {
  if (!isRecord(entry) || typeof entry.kind !== 'string') return false
  const { skills, toolServers } = entry
  return (
    isRecord(skills) &&
    isIndexList(skills.bundledRefs) &&
    Array.isArray(skills.catalog) &&
    skills.catalog.every(isCatalogRef) &&
    isStringList(skills.unknown) &&
    isRecord(toolServers) &&
    isIndexList(toolServers.serverRefs) &&
    isStringList(toolServers.unknown)
  )
}

/** A catalog ref the engine resolves later: the skill id, and whether a miss may be skipped. */
function isCatalogRef(entry: unknown): boolean {
  return isRecord(entry) && typeof entry.skillId === 'string' && typeof entry.optional === 'boolean'
}

/**
 * Every field the harness READS: the skill directory name, the frontmatter description, the body,
 * and each resource's path and content. A missing one would be written to disk as `undefined`.
 */
function isBundledSkill(entry: unknown): entry is BundledSkillDefinition {
  if (!isRecord(entry)) return false
  const { id, name, description, instructions, resources } = entry
  return (
    [id, name, description, instructions].every((field) => typeof field === 'string') &&
    (resources === undefined ||
      (Array.isArray(resources) &&
        resources.every(
          (r) => isRecord(r) && typeof r.relPath === 'string' && typeof r.content === 'string',
        )))
  )
}

/**
 * Every field the executor READS to wire a server: its id, a transport it can reach (a stdio
 * command, or an http URL), and every string the harness renders into the CLI's MCP config or the
 * prompt. A wrong type would reach the container as an `undefined` command or a non-string header.
 */
function isToolServer(entry: unknown): entry is McpServerDefinition {
  if (!isRecord(entry) || typeof entry.id !== 'string' || !isTransport(entry.transport)) {
    return false
  }
  return (
    optional(entry.label, isString) &&
    optional(entry.guidance, isString) &&
    optional(entry.allowedTools, isStringList) &&
    optional(entry.harnesses, isStringList) &&
    optional(entry.secretKeys, (refs) => Array.isArray(refs) && refs.every(isSecretRef)) &&
    optional(entry.oauth, isOAuthConfig)
  )
}

function isTransport(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.kind === 'stdio') {
    return (
      isString(value.command) &&
      optional(value.args, isStringList) &&
      optional(value.env, isStringMap)
    )
  }
  return value.kind === 'http' && isString(value.url) && optional(value.headers, isStringMap)
}

function isSecretRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.key) &&
    optional(value.envName, isString) &&
    optional(value.header, isString) &&
    optional(value.headerTemplate, isString) &&
    optional(value.required, isBoolean) &&
    optional(value.usage, isString)
  )
}

function isOAuthConfig(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.grant === 'authorization_code' || value.grant === 'client_credentials') &&
    isString(value.clientId) &&
    [
      value.clientSecretKey,
      value.authorizationUrl,
      value.tokenUrl,
      value.resource,
      value.header,
      value.headerTemplate,
    ].every((field) => optional(field, isString)) &&
    optional(value.scopes, isStringList)
  )
}

/** An optional field: absent, or present and valid. */
function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isStringMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isString)
}

function isIndexList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(Number.isInteger)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}
