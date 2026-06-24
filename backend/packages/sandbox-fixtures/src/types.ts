import type { SandboxExpectation, SandboxFixtureKind } from '@cat-factory/contracts'

// The authoring format for a builtin Sandbox fixture. These are hand-written and
// committed so runs are reproducible. A definition is the higher-level, ergonomic
// shape; `toSandboxFixture` (registry.ts) projects it into the wire `SandboxFixture`
// the Sandbox stores/serves. We only author *inline* (no-repo) fixtures here — the
// agents whose input is pure text and need no repository checkout.

/** How hard the fixture is, used to offer a simple → complex range per agent. */
export type SandboxFixtureDifficulty = 'simple' | 'moderate' | 'complex'

export interface SandboxFixtureDefinition {
  /** Stable, unique kebab id, e.g. `req-notify-prefs-simple`. */
  id: string
  /**
   * The agent kind this fixture exercises (an `AgentKind` string, e.g.
   * `requirements-review`, `clarity-review`, `reviewer`, `architect-companion`). Used to
   * group fixtures by agent and to look the agent up in the Sandbox catalog.
   */
  agentKind: string
  /** The inline fixture kind (`requirements` | `architecture` | `code-review`). */
  kind: SandboxFixtureKind
  /** Human label for the fixture browser. */
  name: string
  /** Difficulty tier (the simple → complex range). */
  difficulty: SandboxFixtureDifficulty
  /** One-line description of what this fixture probes. */
  summary: string
  /**
   * The inline agent-run context this fixture supplies as input — the synthesized
   * context the agent reasons over (a `RequirementsContext` / `ClarityContext` /
   * reviewer `AgentRunContext`). Kept as a record to match the wire contract; the
   * payload-conformance test asserts each one against the real context type.
   */
  payload: Record<string, unknown>
  /** What a strong answer should surface, each graded by trickiness/impact. */
  expectations: SandboxExpectation[]
  /** Authoring rationale — why this fixture is interesting / what the tricky bits are. */
  notes?: string
}

export type { SandboxExpectation, SandboxFixtureKind }
