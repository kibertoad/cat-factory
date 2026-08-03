import type { Logger, ToolSecretResolver } from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import type { CapabilityCredentialsService } from '@cat-factory/integrations'

// ---------------------------------------------------------------------------
// The PER-WORKSPACE capability-credential resolver, and the composition that puts it in front of
// the deployment-environment one.
//
// `createEnvToolSecretResolver` was the platform's only shipped `ToolSecretResolver`, and an
// environment variable is a single-tenant answer: one process serves every workspace, so one
// variable serves them all. Every tenant's runs then authenticate as whoever set it, a tenant
// cannot bring its own vendor account, and rotating one tenant's key is a redeploy. Every other
// credential in the platform is already a per-tenant sealed row edited in the UI; this is that
// answer for capabilities.
//
// It is a COMPOSITION rather than a replacement, and the fallback is not a compatibility shim:
// a local install, a single-tenant deployment and a CI environment are all shapes where the
// deployment genuinely owns the credential, and for those an environment variable is the right
// mechanism and the one an operator already has wired.
// ---------------------------------------------------------------------------

export interface WorkspaceToolSecretResolverOptions {
  credentials: CapabilityCredentialsService
  logger?: Logger
}

/**
 * A {@link ToolSecretResolver} backed by the workspace's own sealed credential store.
 *
 * Answers only for keys the workspace has STORED. A key it holds nothing for is simply absent
 * from the returned record, which is what lets {@link composeToolSecretResolvers} fall through to
 * the deployment environment — the port's own contract ("an unresolvable key is simply absent")
 * is exactly the composition rule.
 *
 * Ignores the `subject` deliberately, as the env resolver does. A stored key is keyed by NAME
 * because that name is also the environment variable the agent reads it from, and two capabilities
 * sharing one vendor account (an image and a music endpoint behind one key) is a supported case
 * the generative-integration resolver already dedupes for. Swapping the environment for this
 * store therefore changes WHERE a value comes from and not WHO can see it — a deployment that
 * needs per-subject scoping has the port itself.
 */
export function createWorkspaceToolSecretResolver(
  options: WorkspaceToolSecretResolverOptions,
): ToolSecretResolver {
  return {
    resolve: async ({ workspaceId, keys }) => {
      const stored = await options.credentials.resolveValues(workspaceId)
      if (stored.length === 0) return {}
      const byKey = new Map(stored.map((entry) => [entry.key, entry.value]))
      const out: Record<string, string> = {}
      for (const key of keys) {
        const value = byKey.get(key.key)
        if (value) out[key.key] = value
      }
      return out
    },
  }
}

/**
 * Compose resolvers into one, PER KEY: each key takes its value from the first resolver that has
 * one, and a resolver holding nothing for a key never blocks a later one from answering it.
 *
 * Per key rather than per resolver, and the distinction is the whole behaviour. "First resolver
 * that returns anything wins" would mean a workspace that stored ONE of a step's three credentials
 * silently loses the other two — a partially-filled form turning working integrations off, with
 * the run reporting them unavailable and nothing naming the cause.
 *
 * Never throws, per the port's contract. A resolver that rejects is reported and treated as
 * holding nothing, so a store outage degrades to the environment fallback rather than failing
 * every dispatch — the same disposition the two call sites already apply to an unresolved key.
 */
export function composeToolSecretResolvers(
  resolvers: ToolSecretResolver[],
  logger: Logger = noopLogger,
): ToolSecretResolver {
  if (resolvers.length === 1) return resolvers[0]!
  return {
    resolve: async (input) => {
      const out: Record<string, string> = {}
      let pending = input.keys
      for (const resolver of resolvers) {
        if (pending.length === 0) break
        const resolved =
          (await runBestEffort(
            logger,
            'resolve capability credentials',
            () => resolver.resolve({ ...input, keys: pending }),
            { subjectKind: input.subject.kind, subjectId: input.subject.id },
          )) ?? {}
        for (const [key, value] of Object.entries(resolved)) {
          if (value && !(key in out)) out[key] = value
        }
        pending = pending.filter((key) => !(key.key in out))
      }
      return out
    },
  }
}
