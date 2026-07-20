import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { renderSkillForHarness } from './contextFiles.js'

// Coverage for the harness-aware rendering of a resolved `skill` (repo-sourced Claude Skills,
// slice 2): the payload always travels as the top-level `skill` body field; only the PROMPT
// differs by harness (claude-code gets a short pointer, Pi/codex get the folded-in instructions).

type ResolvedSkill = NonNullable<AgentRunContext['skill']>

function skill(overrides: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    skillId: 'src:s:triage',
    name: 'triage',
    description: 'Triage a bug',
    instructions: '1. Reproduce\n2. Classify',
    resources: [
      {
        path: '.claude/skills/triage/templates/report.md',
        relPath: 'templates/report.md',
        body: '# report',
      },
      { path: '.claude/skills/triage/big.bin', relPath: 'big.bin' },
    ],
    ...overrides,
  }
}

describe('renderSkillForHarness', () => {
  it('returns nothing when there is no skill', () => {
    expect(renderSkillForHarness(undefined, 'pi')).toEqual({})
  })

  it('claude-code: body carries only bodied resources; prompt is a short pointer (no instructions)', () => {
    const { body, section } = renderSkillForHarness(skill(), 'claude-code')
    expect(body).toEqual({
      name: 'triage',
      description: 'Triage a bug',
      instructions: '1. Reproduce\n2. Classify',
      resources: [{ relPath: 'templates/report.md', content: '# report' }],
    })
    // The instructions live in the installed SKILL.md, so they are NOT duplicated into the prompt.
    expect(section).not.toContain('1. Reproduce')
    expect(section).toContain('installed for this step as a Claude skill')
    // The un-bodied resource is referenced by its repo path.
    expect(section).toContain('.claude/skills/triage/big.bin')
  })

  it('pi/codex: prompt folds in the full instructions + points at .cat-context/skill', () => {
    const { body, section } = renderSkillForHarness(skill(), 'pi')
    expect(body?.resources).toEqual([{ relPath: 'templates/report.md', content: '# report' }])
    expect(section).toContain('1. Reproduce')
    expect(section).toContain('.cat-context/skill/')
    expect(section).toContain('templates/report.md')
    // Un-bodied resource still referenced by repo path.
    expect(section).toContain('.claude/skills/triage/big.bin')
  })

  it('omits the resource/missing notes when there are no such resources', () => {
    const bare = skill({ resources: [] })
    const cc = renderSkillForHarness(bare, 'claude-code')
    expect(cc.body?.resources).toEqual([])
    expect(cc.section).not.toContain('too large or binary')
    const pi = renderSkillForHarness(bare, 'pi')
    expect(pi.section).not.toContain('.cat-context/skill/')
    expect(pi.section).not.toContain('too large or binary')
  })
})
