import type { DelegatedExecutorDefinition, Logger, ToolSecretResolver } from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import {
  credentialInjectionName,
  isReservedPlatformEnvKey,
  reservedEnvKeyMessage,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The credentials one DELEGATED call is made with.
//
// The sibling of `capabilitySecrets.ts`, and deliberately NOT the same function, because the two
// differ on the thing that shapes all of it: a capability credential becomes an environment
// VARIABLE of an agent process (so toolchain names hijack, a step's whole set of capabilities has
// to be planned as one, and the collision that matters is between two capabilities a step happens
// to select together), whereas these are handed to OUR OWN code (the registered executor's
// `start`/`poll`), and become whatever that code decides, usually an `Authorization` header on a
// call to the deployment's own system. There is no process to reconfigure and no second
// capability to meet, so the cross-declaration planning half has nothing to do here.
//
// One thing does carry over unchanged, because the bag is still keyed by the name the EXECUTOR
// reads: two of ONE definition's credentials resolving to the same name would be one entry, and
// the second value would be gone with nothing said. That is refused where the declaration is
// written (`DelegatedExecutorRegistry.register`), which is why nothing here arbitrates it.
//
// What DOES carry over is the floor, and it carries over for the same reason: the lookup key is a
// boundary. A resolver reads it off the deployment's own environment, so an executor declaring
// `ENCRYPTION_KEY` would hand the deployment's master sealing key to whatever it posts to.
//
// Resolved once per dispatch AND once per poll, never cached on the handle: a delegated step is
// polled for hours and a GitHub App token lives one.
// ---------------------------------------------------------------------------

export interface ResolveDelegationCredentialsInput {
  definition: DelegatedExecutorDefinition
  workspaceId: string
  /** The block, so a per-service credential store can scope its lookup. */
  blockId?: string
  /** Facade-wired; absent ⇒ an empty bag, which the executor's own system reports as a refusal. */
  resolveToolSecrets?: ToolSecretResolver
  logger?: Logger
}

/**
 * Resolve every credential a registered executor declared, keyed by the name the executor reads.
 *
 * Never throws and never fails a dispatch. An unresolvable key simply is not in the bag, and the
 * executor's own call then fails against its own system with that system's own message, which is
 * strictly more useful than a platform-side refusal that names a key the operator has to go and
 * map back to a vendor. The WARN below is what makes the gap visible either way.
 */
export async function resolveDelegationCredentials(
  input: ResolveDelegationCredentialsInput,
): Promise<Record<string, string>> {
  const declared = input.definition.credentials ?? []
  const resolver = input.resolveToolSecrets
  if (declared.length === 0 || !resolver) return {}
  const log = input.logger ?? noopLogger
  const admissible = declared.filter((credential) => {
    if (!isReservedPlatformEnvKey(credential.key)) return true
    // WARN rather than the `debug` an optional missing key gets: this is never a deployment's
    // stated normal, and its fix is a declaration rather than a variable to set.
    log.warn('delegated executor declares a reserved credential key; withholding it', {
      executor: input.definition.id,
      credentialKey: credential.key,
      detail: reservedEnvKeyMessage(credential.key),
    })
    return false
  })
  if (admissible.length === 0) return {}
  const resolved = await runBestEffort(
    log,
    'resolve delegated executor credentials',
    () =>
      resolver.resolve({
        workspaceId: input.workspaceId,
        ...(input.blockId ? { blockId: input.blockId } : {}),
        subject: { kind: 'delegated-executor', id: input.definition.id },
        // Distinct LOOKUP keys: one stored value delivered under two names is an allowed
        // declaration, and asking for the same key twice in one call is not.
        keys: [...new Set(admissible.map((credential) => credential.key))].map((key) => ({ key })),
      }),
    { executor: input.definition.id },
  )
  const bag: Record<string, string> = {}
  for (const credential of admissible) {
    const value = resolved?.[credential.key]
    // The bag is keyed by the name the EXECUTOR reads (`envName` when it declared one, else the
    // lookup key), the same fallback every other capability applies, so a declaration that renames
    // a key for a vendor's SDK reads the same here as it does in a container.
    if (value) {
      bag[credentialInjectionName(credential)] = value
      continue
    }
    if (credential.required === false) {
      log.debug('optional delegated credential did not resolve; calling without it', {
        executor: input.definition.id,
        credentialKey: credential.key,
      })
      continue
    }
    log.warn('delegated credential did not resolve; the executor is called without it', {
      executor: input.definition.id,
      credentialKey: credential.key,
    })
  }
  return bag
}
