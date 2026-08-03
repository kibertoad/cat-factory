import type { BinaryGeneratorSource, Logger } from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type {
  CapabilityCredentialRef,
  CapabilityCredentialStatus,
  CapabilityCredentialsView,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The DECLARATION half of the capability-credential surface: which credentials this deployment's
// registered capabilities want, joined to what the workspace has stored.
//
// This is what turns the store from a blank key-value form into a checklist. Which keys a
// workspace must fill in is not a workspace fact at all — it is a property of the deployment's
// CODE — so without projecting it an operator has to read that code to learn what to type, and a
// typo produces a sealed row nothing ever asks for.
//
// It lives in the server layer rather than in the store's service because it reads registry state,
// and specifically because the generator half must be read through `BinaryGeneratorSource` (the
// rule that every reader of that set routes through the source, so the set a run RESOLVES and the
// set a surface OFFERS cannot drift on a mothership-mode node) — which only the composition root
// can supply.
// ---------------------------------------------------------------------------

/** One capability's declaration of a credential it needs, flattened for the join below. */
export interface DeclaredCapabilityCredential {
  subject: 'tool-server' | 'binary-generator'
  id: string
  label: string
  key: string
  usage?: string
  /** Resolved default, so the fold below need not know each declaration site's own. */
  required: boolean
}

export interface DeclaredCapabilityCredentials {
  declared: DeclaredCapabilityCredential[]
  /**
   * True when the GENERATOR half could not be read. `BinaryGeneratorSource` throws rather than
   * answering an empty set when it cannot reach the mothership, and this surface must not turn
   * that outage into "no integration needs a credential" — the same "absent ≠ zero" rule the
   * workspace snapshot's picker applies to the same read.
   */
  incomplete: boolean
}

export interface CollectDeclaredCredentialsInput {
  agentKindRegistry: AgentKindRegistry
  /** The set a RUN resolves against — this process's registry, or the mothership's. */
  binaryGenerators: BinaryGeneratorSource
  logger?: Logger
}

/** Every credential a registered tool server or generative integration declares. */
export async function collectDeclaredCapabilityCredentials(
  input: CollectDeclaredCredentialsInput,
): Promise<DeclaredCapabilityCredentials> {
  const declared: DeclaredCapabilityCredential[] = []
  const seen = new Set<string>()
  const push = (entry: DeclaredCapabilityCredential): void => {
    // Dedupe on (subject, id, key) — the identity of the DECLARATION — rather than on the key
    // alone, which would drop a second capability's name from `declaredBy` and leave the operator
    // unable to see who else wants the value they are about to change.
    const identity = `${entry.subject}:${entry.id}:${entry.key}`
    if (seen.has(identity)) return
    seen.add(identity)
    declared.push(entry)
  }

  // Enumerated through the KINDS rather than off the server registrations, so the list is the
  // servers some registered kind can actually reach: a server registered by id and attached to
  // nothing never runs, so a credential for it is a key an operator would fill in for no dispatch.
  // This resolves inline and by-reference declarations alike — hence the dedupe.
  for (const kind of input.agentKindRegistry.all()) {
    for (const server of input.agentKindRegistry.toolServersFor(kind.kind).servers) {
      for (const secret of server.secretKeys ?? []) {
        push({
          subject: 'tool-server',
          id: server.id,
          label: server.label ?? server.id,
          key: secret.key,
          // `required` defaults to TRUE at both declaration sites: a credential a capability
          // bothered to declare is one it needs.
          required: secret.required !== false,
        })
      }
    }
  }

  // Best-effort, and its failure is REPORTED rather than swallowed into an empty list: the caller
  // renders `incomplete` beside the result, so an unreachable mothership reads as "this list may
  // be short" instead of "nothing needs a credential".
  const views = await runBestEffort(
    input.logger ?? noopLogger,
    'read generative integrations for the credential checklist',
    () => input.binaryGenerators.views(),
  )
  for (const view of views ?? []) {
    const credential = view.credential
    if (!credential) continue
    push({
      subject: 'binary-generator',
      id: view.id,
      label: view.name,
      key: credential.key,
      ...(credential.usage ? { usage: credential.usage } : {}),
      required: credential.required !== false,
    })
  }
  return { declared, incomplete: views === undefined }
}

/**
 * Join what the deployment DECLARES to what the workspace has STORED.
 *
 * Pure, so the two halves can be tested without a container: the store answers `stored`, the
 * registries answer everything else, and neither knows about the other.
 */
export function buildCapabilityCredentialsView(input: {
  declarations: DeclaredCapabilityCredentials
  stored: CapabilityCredentialRef[]
  environmentFallback: boolean
}): CapabilityCredentialsView {
  const stored = new Map(input.stored.map((ref) => [ref.key, ref]))
  const byKey = new Map<string, DeclaredCapabilityCredential[]>()
  for (const entry of input.declarations.declared) {
    const group = byKey.get(entry.key)
    if (group) group.push(entry)
    else byKey.set(entry.key, [entry])
  }
  const declared: CapabilityCredentialStatus[] = [...byKey.entries()].map(([key, group]) => {
    const ref = stored.get(key)
    return {
      key,
      declaredBy: group.map((entry) => ({
        subject: entry.subject,
        id: entry.id,
        label: entry.label,
        ...(entry.usage ? { usage: entry.usage } : {}),
      })),
      // Required if ANY declarer requires it: the capability that needs it is dropped otherwise,
      // and calling the key optional because a second capability tolerates its absence would
      // understate what a missing value costs.
      required: group.some((entry) => entry.required),
      stored: ref !== undefined,
      ...(ref ? { updatedAt: ref.updatedAt } : {}),
    }
  })
  // A stored key nothing declares is a live secret nobody will ever ask for — which happens
  // whenever the deployment retires an integration or renames a variable. Reported as its own
  // list rather than dropped from the view, because only the operator can tell "delete this" from
  // "the deployment regressed". Suppressed while the declaration read is INCOMPLETE, or an
  // unreachable mothership would report every generator credential as orphaned.
  const orphaned = input.declarations.incomplete
    ? []
    : input.stored.filter((ref) => !byKey.has(ref.key))
  return {
    declared: declared.sort((a, b) => a.key.localeCompare(b.key)),
    orphaned: orphaned.sort((a, b) => a.key.localeCompare(b.key)),
    environmentFallback: input.environmentFallback,
    declarationsIncomplete: input.declarations.incomplete,
  }
}
