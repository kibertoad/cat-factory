import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// The mothership-mode agent-kind CAPABILITY read (`GET /internal/agent-kinds`) as a node receives
// it. The machine gate is asserted beside its siblings in `core-workspaces.ts`; this asserts the
// REPLY: a bundled skill assigned to several kinds rides once, by reference, on every runtime.

const PLAYBOOK = {
  id: 'conformance.shared-playbook',
  name: 'shared-playbook',
  description: 'A playbook several kinds apply.',
  instructions: 'Follow the house rules.',
  resources: [{ relPath: 'rules.md', content: '# Rules' }],
}

export function defineAgentKindLayerConformance(harness: ConformanceHarness): void {
  describe('agent-kind capability layer over the machine API', () => {
    it('serves a bundled skill assigned to several kinds ONCE, referenced by each', async () => {
      const registry = defaultAgentKindRegistry()
      registry.registerSkill(PLAYBOOK)
      registry.assignSkills('coder', [PLAYBOOK.id])
      registry.assignSkills('pr-reviewer', [PLAYBOOK.id])
      const app = harness.makeApp({}, { agentKindRegistry: registry })
      // A harness with no session secret has no machine audience to sign for.
      if (!app.authEnabled) return

      const res = await app.call<{
        kinds: { kind: string; skills: { bundledRefs: number[] } }[]
        bundledSkills: { id: string; instructions: string }[]
      }>('GET', '/internal/agent-kinds', undefined, {
        authorization: `Bearer ${await app.machineToken()}`,
      })

      expect(res.status).toBe(200)
      expect(res.body.bundledSkills).toEqual([PLAYBOOK])
      const byKind = new Map(res.body.kinds.map((view) => [view.kind, view.skills.bundledRefs]))
      expect(byKind.get('coder')).toEqual([0])
      expect(byKind.get('pr-reviewer')).toEqual([0])
    })
  })
}
