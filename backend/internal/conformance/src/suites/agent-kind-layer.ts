import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// The mothership-mode agent-kind CAPABILITY read (`GET /internal/agent-kinds`) as a node receives
// it. The machine gate is asserted beside its siblings in `core-workspaces.ts`; this asserts the
// REPLY: a skill or tool server assigned to several kinds rides once, by reference, on every
// runtime.

const PLAYBOOK = {
  id: 'conformance.shared-playbook',
  name: 'shared-playbook',
  description: 'A playbook several kinds apply.',
  instructions: 'Follow the house rules.',
  resources: [{ relPath: 'rules.md', content: '# Rules' }],
}

const TRACKER = {
  id: 'conformance-tracker',
  transport: { kind: 'stdio' as const, command: 'tracker-mcp', args: [] },
}

export function defineAgentKindLayerConformance(harness: ConformanceHarness): void {
  describe('agent-kind capability layer over the machine API', () => {
    it('serves a definition assigned to several kinds ONCE, referenced by each', async () => {
      const registry = defaultAgentKindRegistry()
      registry.registerSkill(PLAYBOOK)
      registry.assignSkills('coder', [PLAYBOOK.id])
      registry.assignSkills('pr-reviewer', [PLAYBOOK.id])
      registry.registerToolServer(TRACKER)
      registry.assignToolServers('coder', [TRACKER.id])
      registry.assignToolServers('pr-reviewer', [TRACKER.id])
      const app = harness.makeApp({}, { agentKindRegistry: registry })
      // Asserted, never an early return: every facade that wires this suite runs auth-enabled, and
      // a per-test `if (!app.authEnabled) return` would let a mis-wired harness pass VACUOUSLY.
      expect(app.authEnabled).toBe(true)

      const res = await app.call<{
        kinds: {
          kind: string
          skills: { bundledRefs: number[] }
          toolServers: { serverRefs: number[] }
        }[]
        bundledSkills: unknown[]
        toolServers: unknown[]
      }>('GET', '/internal/agent-kinds', undefined, {
        authorization: `Bearer ${await app.machineToken()}`,
      })

      expect(res.status).toBe(200)
      // Relations, not totals: the default registry's built-in kinds contribute their own
      // declarations, which this suite does not own.
      const playbookAt = onlyIndexOf(res.body.bundledSkills, PLAYBOOK)
      const trackerAt = onlyIndexOf(res.body.toolServers, TRACKER)
      for (const kind of ['coder', 'pr-reviewer']) {
        const view = res.body.kinds.find((entry) => entry.kind === kind)
        expect(view?.skills.bundledRefs).toContain(playbookAt)
        expect(view?.toolServers.serverRefs).toContain(trackerAt)
      }
    })
  })
}

/** The one index at which `value` appears in `table`, failing when it appears zero or several times. */
function onlyIndexOf(table: readonly unknown[], value: unknown): number {
  const at = table.flatMap((entry, index) =>
    JSON.stringify(entry) === JSON.stringify(value) ? [index] : [],
  )
  expect(at).toHaveLength(1)
  return at[0]!
}
