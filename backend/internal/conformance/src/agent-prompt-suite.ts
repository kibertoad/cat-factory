import type { AgentPromptRepository, AgentPromptRevision } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the per-workspace agent system-prompt override store — the
// append-only revision log behind the pipeline builder's prompt editor (D1 on Cloudflare,
// Drizzle/Postgres on Node).
//
// Three of its behaviours are easy to get subtly wrong in one store only, so each is asserted
// here rather than left to whichever facade a test happens to run against:
//
//  - `text: null` must ROUND-TRIP as null. It is the "go back to the shipped built-in"
//    revision, and a store that coerced it to `''` would make the engine send an EMPTY system
//    prompt instead of the built-in one — a silent, run-destroying difference.
//  - `head` / `listHeads` must pick the highest REVISION, not the newest row or the last
//    inserted. `listHeads` in particular is a per-kind aggregate written differently in each
//    store (a correlated MAX vs a grouped subquery join), which is exactly where a per-kind
//    grouping bug hides.
//  - `append` must REFUSE a duplicate revision. The next revision number is computed from a
//    read, so that refusal is the concurrency control: a store that upserted instead would let
//    one editor's prompt silently replace another's.

function revision(overrides: Partial<AgentPromptRevision> = {}): AgentPromptRevision {
  return {
    agentKind: 'coder',
    revision: 1,
    text: 'You are a careful engineer. Prefer the smallest correct change.',
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link AgentPromptRepository} behaves identically to the others.
 * `makeRepo` returns a repository over the runtime's real store; ids are unique per run so the
 * shared database stays isolated.
 */
export function defineAgentPromptSuite(name: string, makeRepo: () => AgentPromptRepository): void {
  describe(`[${name}] agent prompt repository parity`, () => {
    let seq = 0
    const nextWs = () => {
      seq += 1
      return `ws-ap-${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    it('round-trips a full revision, including the optional restoredFrom / createdBy', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      const entity = revision({ restoredFrom: undefined, createdBy: 'usr_1' })
      await repo.append(ws, entity)

      expect(await repo.listRevisions(ws, 'coder')).toEqual([entity])
      expect(await repo.head(ws, 'coder')).toEqual(entity)
    })

    it('omits absent optional fields rather than returning them as null', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      await repo.append(ws, revision())

      const [head] = await repo.listRevisions(ws, 'coder')
      expect(head).not.toHaveProperty('restoredFrom')
      expect(head).not.toHaveProperty('createdBy')
    })

    it('round-trips a null text as null — the "back to the built-in" revision', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      await repo.append(ws, revision({ revision: 1, text: 'custom' }))
      await repo.append(ws, revision({ revision: 2, text: null, restoredFrom: 1 }))

      const head = await repo.head(ws, 'coder')
      // Null, never '' — the engine reads `head.text ?? undefined`, so a coerced empty string
      // would send an EMPTY system prompt instead of falling back to the shipped one.
      expect(head?.text).toBeNull()
      expect(head?.restoredFrom).toBe(1)
    })

    it('returns nothing for an untouched kind, and never leaks another kind or workspace', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      const other = nextWs()
      await repo.append(ws, revision({ agentKind: 'coder' }))
      await repo.append(other, revision({ agentKind: 'coder', text: 'other workspace' }))

      expect(await repo.listRevisions(ws, 'architect')).toEqual([])
      expect(await repo.head(ws, 'architect')).toBeNull()
      expect((await repo.head(other, 'coder'))?.text).toBe('other workspace')
    })

    it('orders the log newest-first and resolves the head by highest revision', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      // Inserted out of order on purpose: the head is the highest REVISION, not the last row
      // written, so a store ordering by insertion or by `created_at` fails here.
      await repo.append(ws, revision({ revision: 1, text: 'v1', createdAt: 30 }))
      await repo.append(ws, revision({ revision: 3, text: 'v3', createdAt: 10 }))
      await repo.append(ws, revision({ revision: 2, text: 'v2', createdAt: 20 }))

      expect((await repo.listRevisions(ws, 'coder')).map((r) => r.revision)).toEqual([3, 2, 1])
      expect((await repo.head(ws, 'coder'))?.text).toBe('v3')
    })

    it('lists one head per kind across the workspace', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      await repo.append(ws, revision({ agentKind: 'coder', revision: 1, text: 'c1' }))
      await repo.append(ws, revision({ agentKind: 'coder', revision: 2, text: 'c2' }))
      await repo.append(ws, revision({ agentKind: 'architect', revision: 1, text: 'a1' }))
      await repo.append(ws, revision({ agentKind: 'reviewer', revision: 1, text: null }))

      const heads = await repo.listHeads(ws)
      expect(heads.map((h) => [h.agentKind, h.revision, h.text])).toEqual([
        ['architect', 1, 'a1'],
        ['coder', 2, 'c2'],
        // A reverted kind still has a head — the index reports it as NOT customized rather
        // than dropping the row, so the editor can show that someone went back deliberately.
        ['reviewer', 1, null],
      ])
    })

    it('refuses a duplicate revision instead of overwriting it', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      await repo.append(ws, revision({ revision: 1, text: 'first writer' }))

      await expect(
        repo.append(ws, revision({ revision: 1, text: 'second writer' })),
      ).rejects.toThrow()
      // The refusal is the point: the first writer's prompt is still what runs.
      expect((await repo.head(ws, 'coder'))?.text).toBe('first writer')
    })

    it('preserves a large prompt body verbatim', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      // Newlines, quotes and backslashes all survive — a prompt is prose, and a store that
      // mangled them would corrupt every run in the workspace.
      const text = `Line one\n\n"quoted" and 'single' and \\backslash\\\n${'x'.repeat(20_000)}`
      await repo.append(ws, revision({ text }))

      expect((await repo.head(ws, 'coder'))?.text).toBe(text)
    })
  })
}
