import type {
  AgentKindCapabilityView,
  AgentKindRegistry,
  AgentKindSource,
} from '@cat-factory/agents'
import {
  bundledSkillToResolved,
  mergeKindCapabilities,
  SKILL_AGENT_KIND,
} from '@cat-factory/agents'
import type { PipelineStep } from '@cat-factory/contracts'
import type { AgentKind, Logger, ResolvedSkill, SkillVersionPin } from '@cat-factory/kernel'
import { ValidationError, noopLogger, runBestEffort } from '@cat-factory/kernel'
import type { SkillResolver } from './AgentContextBuilder.js'

// ---------------------------------------------------------------------------
// Resolve the skills ONE dispatch runs: the agent KIND's declared skills (bundled with the
// deployment's package, or referenced from the account's synced catalog) plus the step's own
// picked skill (`stepOptions.skillId`, what the built-in `skill` kind runs).
//
// Extracted from `AgentContextBuilder` as a cohesive collaborator — it owns the two sources'
// precedence, the catalog resolution, the per-run version pinning and the failure policy, none
// of which the context builder's remaining ~40 resolutions need to see.
// ---------------------------------------------------------------------------

export interface ResolveRunSkillsInput {
  workspaceId: string
  /** The EFFECTIVE dispatched kind (a gate helper dispatches its own kind, not the step's). */
  agentKind: AgentKind
  /** The step being dispatched; its `skillVersions` pin is written here. */
  step: PipelineStep
  agentKindRegistry: AgentKindRegistry
  /**
   * This dispatch's already-resolved capability declarations (see {@link resolveKindCapabilities}).
   * Passed IN rather than resolved here because the tool-server half of the same answer travels to
   * the executor, and resolving twice would mean two reads of a deployment-level source that
   * crosses a network. Absent ⇒ resolved from `agentKindRegistry` alone.
   */
  capabilities?: AgentKindCapabilityView
  /** Wired only when the skill library is configured; absent ⇒ no catalog skill can resolve. */
  skillResolver?: SkillResolver
  logger?: Logger
}

/**
 * Resolve every skill this dispatch applies, in the order they should be applied: the kind's own
 * declarations first (its standing playbooks), then the step's picked skill. Deduplicated by
 * skill id, so a step that picks a skill its kind already declares runs it once.
 *
 * The failure policy differs by SOURCE, deliberately:
 *
 * - **The step's picked skill** is a hard failure when it cannot resolve (no resolver wired) —
 *   the whole point of that step is to run that skill, so a silent skip is a wrong run. This is
 *   the pre-existing `skill`-kind contract, unchanged.
 * - **A kind's declared CATALOG skill** is a hard failure too unless it declared itself
 *   `optional`: a kind that names a skill by id is saying it needs it to do the work. Marking it
 *   optional is how a kind says "apply the house playbook if this deployment has one".
 * - **A kind's declared BUNDLED skill** cannot fail: it ships in the deployment's own code.
 *
 * Returns the resolved skills plus the CATALOG version pins (a bundled skill has no pin — its
 * version is the deployment's), which the caller records on the step.
 */
export async function resolveRunSkills(
  input: ResolveRunSkillsInput,
): Promise<{ skills: ResolvedSkill[]; versions: SkillVersionPin[] }> {
  const declared = (input.capabilities ?? (await resolveKindCapabilities(input.agentKind, input)))
    .skills
  const pickedSkillId =
    input.agentKind === SKILL_AGENT_KIND ? input.step.stepOptions?.skillId?.trim() : undefined
  if (!declared.bundled.length && !declared.catalog.length && !pickedSkillId) {
    // Clear on this path too, not just the one below: a step re-dispatched after its pick was
    // removed (or its kind's declaration dropped) lands HERE, and leaving the prior round's pin
    // in place would report "this run executed that version" of a skill it never touched.
    input.step.skillVersions = undefined
    return { skills: [], versions: [] }
  }

  // A registered id with no registration is a deployment typo. It is reported at BOOT
  // (`validateRegistrations`), so by the time a run reaches here the loud channel has already
  // fired — dropping it with a warning is right, because failing the run cannot fix the typo.
  for (const id of declared.unknown) {
    input.logger?.warn('agent kind declares an unregistered skill id; skipping it', {
      agentKind: input.agentKind,
      skillId: id,
    })
  }

  const skills: ResolvedSkill[] = declared.bundled.map(bundledSkillToResolved)
  const versions: SkillVersionPin[] = []
  const seen = new Set(skills.map((s) => s.skillId))

  for (const ref of declared.catalog) {
    if (seen.has(ref.skillId)) continue
    const resolved = await resolveCatalogSkill(input, ref.skillId, ref.optional)
    if (!resolved) continue
    seen.add(resolved.skill.skillId)
    skills.push(resolved.skill)
    versions.push(resolved.version)
  }

  if (pickedSkillId && !seen.has(pickedSkillId)) {
    const resolved = await resolveCatalogSkill(input, pickedSkillId, false)
    if (resolved) {
      skills.push(resolved.skill)
      versions.push(resolved.version)
    }
  }

  // Assigned unconditionally (cleared when nothing pinned) rather than only on success: a step
  // re-dispatched after its skill was removed upstream would otherwise keep reporting the prior
  // round's pin, which reads as "this run executed that version" when it did not.
  input.step.skillVersions = versions.length ? versions : undefined
  return { skills, versions }
}

/**
 * The capability declarations one dispatch applies: this build's registry MERGED with the
 * deployment's layer when a source is wired (a mothership-mode node reads the mothership's).
 *
 * A merge, not a replacement, and that is the difference from the three sibling sources
 * (foundational services, binary generators, prompt fragments), which forbid one. Those replace a
 * set the node also registers, so a merge would let a stale local copy win by id. Here the halves
 * are different things: a KIND's own declarations belong to the code implementing it and stay with
 * that code, while the deployment's `assignSkills`/`assignToolServers` are a layer on top. This is
 * the same union `skillsFor` already performs in-process, with the deployment's half read from the
 * process that owns it.
 *
 * Exported because the TOOL-SERVER half of the same answer is resolved here too and rides the
 * dispatch context to the executor, which is what keeps this to ONE read per dispatch.
 */
export async function resolveKindCapabilities(
  agentKind: AgentKind,
  deps: { agentKindRegistry: AgentKindRegistry; agentKindSource?: AgentKindSource },
): Promise<AgentKindCapabilityView> {
  const local: AgentKindCapabilityView = {
    kind: agentKind,
    skills: deps.agentKindRegistry.skillsFor(agentKind),
    toolServers: deps.agentKindRegistry.toolServersFor(agentKind),
  }
  if (!deps.agentKindSource) return local
  // A failed read THROWS out of the source and is NOT swallowed here: an empty layer and an
  // unreachable mothership are the same value and opposite facts, and a dispatch that quietly
  // dropped the org's playbook is the exact failure this seam exists to remove.
  const org = (await deps.agentKindSource.capabilities()).find((view) => view.kind === agentKind)
  return mergeKindCapabilities(local, org)
}

/**
 * Resolve ONE account-catalog skill. An unwired resolver, or a resolver that throws (an unknown /
 * tombstoned skill id), fails the dispatch unless the reference declared itself optional — in
 * which case the skill is skipped with a logged reason, never in silence. A resource-fetch
 * failure inside the resolver already degrades to a body-less reference and never throws, so a
 * transient GitHub blip cannot reach this branch.
 */
async function resolveCatalogSkill(
  input: ResolveRunSkillsInput,
  skillId: string,
  optional: boolean,
): Promise<{ skill: ResolvedSkill; version: SkillVersionPin } | null> {
  if (!input.skillResolver) {
    if (!optional) {
      throw new ValidationError(
        `This pipeline step runs the skill '${skillId}', but the skill library is not configured for this deployment.`,
      )
    }
    input.logger?.info('optional skill skipped: the skill library is not configured', { skillId })
    return null
  }
  const resolver = input.skillResolver
  if (optional) {
    const resolved = await runBestEffort(
      input.logger ?? noopLogger,
      'resolve optional agent-kind skill',
      async () => {
        const { skill, version } = await resolver.resolveForRun(input.workspaceId, skillId)
        return { skill: { ...skill, origin: 'catalog' as const }, version }
      },
      { skillId },
    )
    return resolved ?? null
  }
  const { skill, version } = await resolver.resolveForRun(input.workspaceId, skillId)
  return { skill: { ...skill, origin: 'catalog' }, version }
}
