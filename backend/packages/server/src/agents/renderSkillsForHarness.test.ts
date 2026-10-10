import type { ResolvedSkill } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { renderSkillsForHarness } from './contextFiles.js'

// Coverage for the harness-aware rendering of a dispatch's resolved skills (a step's picked skill
// and/or the running kind's declared playbooks): the payload always travels as the top-level
// `skills` body field; only the PROMPT differs by harness (a NATIVE claude-code install gets a
// short pointer, every checkout-reading case — Pi, codex, and AMBIENT claude-code — gets the
// folded-in instructions).

function skill(overrides: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    skillId: 'src:s:triage',
    origin: 'catalog',
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

describe('renderSkillsForHarness', () => {
  it('returns nothing when the dispatch applies no skills', () => {
    expect(renderSkillsForHarness(undefined, 'pi')).toEqual({})
    expect(renderSkillsForHarness([], 'pi')).toEqual({})
  })

  it('claude-code: body carries only bodied resources; prompt is a short pointer (no instructions)', () => {
    const { body, section } = renderSkillsForHarness([skill()], 'claude-code')
    expect(body).toEqual([
      {
        name: 'triage',
        description: 'Triage a bug',
        instructions: '1. Reproduce\n2. Classify',
        resources: [{ relPath: 'templates/report.md', content: '# report' }],
      },
    ])
    // The instructions live in the installed SKILL.md, so they are NOT duplicated into the prompt.
    expect(section).not.toContain('1. Reproduce')
    expect(section).toContain('installed for this step as a Claude skill')
    // The un-bodied resource is referenced by its repo path.
    expect(section).toContain('.claude/skills/triage/big.bin')
  })

  it('pi/codex: prompt folds in the full instructions + points at the skill’s .cat-context dir', () => {
    const { body, section } = renderSkillsForHarness([skill()], 'pi')
    expect(body?.[0]?.resources).toEqual([{ relPath: 'templates/report.md', content: '# report' }])
    expect(section).toContain('1. Reproduce')
    // Per-skill subdirectory: several skills can apply to one run, so a flat dir would collide.
    expect(section).toContain('.cat-context/skill/triage/')
    expect(section).toContain('templates/report.md')
    // Un-bodied resource still referenced by repo path.
    expect(section).toContain('.claude/skills/triage/big.bin')
  })

  it('ambient claude-code: folds in the instructions, because nothing is installed natively', () => {
    // A native run has an isolated CLAUDE_CONFIG_DIR to install into; an ambient one does not, and
    // the harness refuses to write a skill into the developer's own ~/.claude. Rendering it as an
    // install would hand the agent a pointer to a skill that is nowhere on disk.
    const { body, section } = renderSkillsForHarness([skill()], 'claude-code', true)
    expect(body?.[0]?.resources).toEqual([{ relPath: 'templates/report.md', content: '# report' }])
    expect(section).not.toContain('installed for this step as a Claude skill')
    expect(section).toContain('1. Reproduce')
    expect(section).toContain('.cat-context/skill/triage/')
  })

  it('ambient makes no difference to codex/Pi, which always read the checkout', () => {
    expect(renderSkillsForHarness([skill()], 'codex', true)).toEqual(
      renderSkillsForHarness([skill()], 'codex'),
    )
  })

  it('several skills: every payload rides the body and the prompt numbers them as a set', () => {
    const second = skill({
      skillId: 'bundled:house-style',
      origin: 'bundled',
      name: 'house-style',
      instructions: 'Follow the house style',
      resources: [],
    })
    const { body, section } = renderSkillsForHarness([skill(), second], 'pi')
    expect(body?.map((b) => b.name)).toEqual(['triage', 'house-style'])
    expect(section).toContain('Apply these skills to this task, all of them:')
    expect(section).toContain('1. ')
    expect(section).toContain('2. ')
    expect(section).toContain('Follow the house style')
  })

  it('omits the resource/missing notes when there are no such resources', () => {
    const bare = [skill({ resources: [] })]
    const cc = renderSkillsForHarness(bare, 'claude-code')
    expect(cc.body?.[0]?.resources).toEqual([])
    expect(cc.section).not.toContain('too large or binary')
    const pi = renderSkillsForHarness(bare, 'pi')
    expect(pi.section).not.toContain('.cat-context/skill/')
    expect(pi.section).not.toContain('too large or binary')
  })
})
