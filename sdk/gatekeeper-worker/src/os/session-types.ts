// The `.d.ts` a session serves through `getTypeScriptTypes()`, composed for one tier.
//
// The per-operation signatures are GENERATED (`@cat-factory/gatekeeper-bindings`'s
// `SESSION_METHOD_SIGNATURES`, rendered by `pnpm gen:sdk` from the same spec the bindings table
// comes from), so the types an agent codes against cannot describe a surface the deployment does
// not serve. What is composed here is the tier's own subset plus the reserved methods, because a
// session carries exactly what its policy granted: a file naming the whole surface would promise
// methods the object does not have.
//
// The reserved methods are written out here rather than generated because they are this package's,
// not the deployment's: they exist at exactly the same version as this file.

import { renderSessionTypes } from '@cat-factory/gatekeeper-bindings'
import type { CompiledTier } from '../policy/compile.js'

/** The type name a resource declares as its `tsType`, and the interface the `.d.ts` exports. */
export const SESSION_INTERFACE_NAME = 'CatFactoryWorkspace'

/**
 * The methods every session carries whatever its policy: who the caller is, what they hold, what
 * they do not, and the approval inbox.
 *
 * `withheld()` is the one worth reading twice. An agent that cannot tell "your policy hides this"
 * from "no policy could grant this" from "ask for it another way" reports the wrong one to whoever
 * has to fix it, which is why it is on the object rather than in a document.
 */
const RESERVED_MEMBERS: readonly string[] = [
  `  /** Who this session acts as, and the policy tier that account resolved to. */
  tier(): Promise<{ actorId: string; tier: string; description: string; keyScope: string }>
`,
  `  /**
   * Every operation this session carries, with the scope floor and consequence of each.
   */
  bindings(): Promise<
    {
      name: string
      summary: string
      minScope: string
      readOnly: boolean
      destructive: boolean
      idempotent: boolean
      pathParams: readonly string[]
      queryParams: readonly { name: string; required: boolean }[]
      hasBody: boolean
    }[]
  >
`,
  `  /**
   * Every operation this session does NOT carry, and why: \`not_in_policy\` and
   * \`denied_by_policy\` are your operator's decision, \`above_key_scope\` needs a higher tier,
   * and \`not_relayable\` cannot cross a session call at all (ask for it another way).
   */
  withheld(): Promise<{ name: string; reason: string; detail: string }[]>
`,
  `  /** The approval cards the paired deployment has raised and this Gatekeeper still holds open. */
  approvals_list(): Promise<unknown[]>
`,
  `  /**
   * What a card's run is ACTUALLY parked on now, with the verbs each park takes and whether this
   * session holds the operation behind it. The card is a pointer; the run is the truth.
   */
  approvals_inspect(cardId: string): Promise<unknown>
`,
  `  /**
   * Answer a park. Three outcomes are distinguishable and all three matter: \`answered\` (the run
   * is unparked), \`recorded\` (your vote counted, the quorum is unmet, the run is still parked)
   * and \`stale\` (the run moved on).
   */
  approvals_answer(cardId: string, input: unknown): Promise<unknown>
`,
  `  /** Every run this Gatekeeper has been pushed lifecycle events for. */
  runs_watched(): Promise<unknown[]>
`,
]

/** Render the session `.d.ts` for one compiled tier. */
export function renderTierSessionTypes(tier: CompiledTier): string {
  return renderSessionTypes({
    interfaceName: SESSION_INTERFACE_NAME,
    bindings: tier.granted.map((binding) => binding.name),
    extraMembers: RESERVED_MEMBERS,
    preamble:
      `// The session for policy tier \`${tier.name}\`: ${tier.description}\n` +
      `// Calls are made with a per-account API key at scope \`${tier.keyScope}\`, and every one of\n` +
      "// them passes through this workspace's approval queue.",
  })
}
