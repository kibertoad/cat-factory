import {
  type AgentKindRegistry,
  type BundledSkillDefinition,
  bundledSkillDefinitionSchema,
  definitionIssues,
} from '@cat-factory/agents'
import type { AgentKind } from '@cat-factory/kernel'
import type { RegistrationProblem } from './validateRegistrations.js'
import { declaredOn } from './validateToolServers.js'

/**
 * A bundled skill whose SHAPE does not match `BundledSkillDefinition` (a JS-authored or
 * config-loaded definition with a missing `name`, or a resource whose `content` is not a string).
 * An error, because the harness writes each of those fields to disk, and a mothership-mode node
 * refuses the whole capability layer that carries the skill.
 *
 * Checked once per DEFINITION rather than once per kind, the way `checkToolServerDefinitions` does:
 * a shared skill is one registration and one edit, so the message names every kind it is on.
 */
export function checkSkillDefinitions(
  kinds: readonly AgentKind[],
  registry: AgentKindRegistry,
): RegistrationProblem[] {
  const declaredFor = new Map<BundledSkillDefinition, AgentKind[]>()
  for (const kind of kinds) {
    for (const skill of registry.skillsFor(kind).bundled) {
      const already = declaredFor.get(skill)
      if (already) already.push(kind)
      else declaredFor.set(skill, [kind])
    }
  }
  return [...declaredFor].flatMap(([skill, on]): RegistrationProblem[] => {
    const issues = definitionIssues(bundledSkillDefinitionSchema, skill)
    if (!issues.length) return []
    return [
      {
        severity: 'error',
        code: 'invalid_bundled_skill_definition',
        message:
          `Bundled skill "${String(skill.id)}" ${declaredOn(on)} does not match the ` +
          `BundledSkillDefinition shape: ${issues.join('; ')}.`,
      },
    ]
  })
}
