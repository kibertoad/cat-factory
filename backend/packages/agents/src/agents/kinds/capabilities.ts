import type { McpServerDefinition, ResolvedSkill } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The capability DECLARATIONS an agent kind carries: the skills it applies and the tool
// servers (MCP) it may call. Both are references resolved at dispatch — this module owns the
// reference vocabulary plus the pure normalisers that turn a kind's declarations into the
// concrete definitions the engine resolves.
//
// The shape is deliberately the same for both: a registered id (share one definition across
// many kinds), or an inline definition (a one-off that belongs to a single kind). The third
// skill form — a CATALOG reference — has no tool-server equivalent, because a tool server is
// deployment infrastructure while a skill is authored content that a tenant may own.
// ---------------------------------------------------------------------------

/**
 * A skill shipped IN CODE by a deployment's agent package and registered on the
 * `AgentKindRegistry`. Structurally the content of a `SKILL.md` — the same payload the
 * repo-synced catalog produces — so it reaches the harness through the identical path with
 * nothing downstream branching on origin.
 *
 * The point of a bundled skill is that a custom agent kind can carry its own procedural playbook
 * with no skill library configured, no repo sync, and no GitHub connection: a deployment that
 * installs the package gets the skill.
 */
export interface BundledSkillDefinition {
  /** Stable id, referenced from a kind's `skills` and reported on the run. */
  id: string
  /** The skill name — becomes the native CLI skill directory name and its frontmatter `name`. */
  name: string
  /** One-line description (the frontmatter `description` the CLI matches against). */
  description: string
  /** The procedural instructions — the `SKILL.md` body. */
  instructions: string
  /** Optional resource files, materialised alongside the skill. */
  resources?: { relPath: string; content: string }[]
}

/** A skill an agent kind applies: a registered bundled id, an inline bundled skill, or a catalog ref. */
export type AgentKindSkillRef =
  | string
  | BundledSkillDefinition
  | {
      /**
       * An account-tier repo-synced skill id (`src:<sourceId>:<dirName>`, ADR 0024). Resolved
       * through the engine's `skillResolver`, so it needs the skill library to be configured.
       */
      catalogSkillId: string
      /**
       * When true, a skill that cannot be resolved (library unconfigured, skill removed or its
       * source unlinked) is SKIPPED with a note instead of failing the dispatch. Defaults to
       * false: a kind that declares a skill by id is declaring it is required to do the work,
       * and running it without the skill produces work nobody asked for.
       */
      optional?: boolean
    }

/** A tool server an agent kind may call: a registered server id, or an inline definition. */
export type AgentKindToolRef = string | McpServerDefinition

/** A kind's skill declaration, normalised into the two shapes the engine resolves separately. */
export interface NormalizedSkillRefs {
  /** Bundled skills, already complete — nothing to resolve. */
  bundled: BundledSkillDefinition[]
  /** Catalog references the engine resolves through `skillResolver`. */
  catalog: { skillId: string; optional: boolean }[]
}

/** Whether a skill ref names a repo-synced catalog skill. */
function isCatalogRef(
  ref: AgentKindSkillRef,
): ref is { catalogSkillId: string; optional?: boolean } {
  return typeof ref === 'object' && 'catalogSkillId' in ref
}

/**
 * Normalise an agent kind's `skills` declaration, resolving each registered id against `lookup`.
 * An id with no registration is returned in `unknown` rather than thrown on, so the caller
 * decides the severity — boot validation reports it as a startup error (the loud, early place),
 * while a dispatch drops it rather than failing a run over a registry typo it cannot fix.
 *
 * Pure, so the precedence and dedup are unit-testable without a registry or a run.
 */
export function normalizeSkillRefs(
  refs: readonly AgentKindSkillRef[] | undefined,
  lookup: (id: string) => BundledSkillDefinition | undefined,
): NormalizedSkillRefs & { unknown: string[] } {
  const bundled: BundledSkillDefinition[] = []
  const catalog: { skillId: string; optional: boolean }[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const ref of refs ?? []) {
    if (isCatalogRef(ref)) {
      if (seen.has(ref.catalogSkillId)) continue
      seen.add(ref.catalogSkillId)
      catalog.push({ skillId: ref.catalogSkillId, optional: ref.optional === true })
      continue
    }
    const definition = typeof ref === 'string' ? lookup(ref) : ref
    if (!definition) {
      unknown.push(ref as string)
      continue
    }
    if (seen.has(definition.id)) continue
    seen.add(definition.id)
    bundled.push(definition)
  }
  return { bundled, catalog, unknown }
}

/**
 * Normalise an agent kind's `toolServers` declaration, resolving each registered id against
 * `lookup`. Unknown ids are reported (never thrown) for the same reason as {@link normalizeSkillRefs};
 * duplicates collapse by server id, so assigning a server a kind already declares is idempotent.
 */
export function normalizeToolRefs(
  refs: readonly AgentKindToolRef[] | undefined,
  lookup: (id: string) => McpServerDefinition | undefined,
): { servers: McpServerDefinition[]; unknown: string[] } {
  const servers: McpServerDefinition[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const ref of refs ?? []) {
    const definition = typeof ref === 'string' ? lookup(ref) : ref
    if (!definition) {
      unknown.push(ref as string)
      continue
    }
    if (seen.has(definition.id)) continue
    seen.add(definition.id)
    servers.push(definition)
  }
  return { servers, unknown }
}

/** Project a bundled skill definition into the resolved shape the engine puts on the run context. */
export function bundledSkillToResolved(definition: BundledSkillDefinition): ResolvedSkill {
  return {
    skillId: definition.id,
    origin: 'bundled',
    name: definition.name,
    description: definition.description,
    instructions: definition.instructions,
    // A bundled resource is already in memory, so it always carries its body — the
    // "reference by repo path" degradation only exists for a catalog fetch that failed.
    resources: (definition.resources ?? []).map((r) => ({
      path: r.relPath,
      relPath: r.relPath,
      body: r.content,
    })),
  }
}
