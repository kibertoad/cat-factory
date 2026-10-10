// What a mothership-mode boot has to say about the registries THIS node owns in code.
//
// A mothership deployment is two processes, and a node one build behind is the normal state of
// running one, so the org-scoped registries (the foundational-service estate, the generative binary
// integrations) are resolved from the MOTHERSHIP and a node consults no copy of its own. Anything
// registered here is therefore inert, which is worth one boot line naming the ids: the shape a
// deployment written before those sets crossed the machine API has is a registration on BOTH entry
// points, and it reads like deliberate wiring rather than the workaround it was.
//
// The line is only worth printing about what a deployment can act on, which is what this module
// exists to decide.

/**
 * The ids of what THIS deployment registered on a code-owned registry, given everything registered
 * and the definitions the PLATFORM ships.
 *
 * The shipped ones are subtracted rather than reported, because they are not something the
 * deployment wired: every facade seeds these registries with the platform's own set, so naming them
 * would fire the warning on every mothership-mode boot and tell an operator to undo a registration
 * they never made.
 *
 * Subtracted by IDENTITY, never by id. A deployment that replaces a shipped id with its own
 * definition is precisely the case the warning exists for: the replacement is as inert on a node as
 * a brand-new registration is, and an id test would call it a built-in and stay silent. Identity
 * answers it because the shipped definitions are shared, frozen constants
 * (`PLATFORM_FOUNDATIONAL_SERVICES`, `BUILTIN_BINARY_GENERATORS`), so a definition that is not one
 * of those objects came from the deployment's own code by construction.
 */
export function deploymentRegisteredIds<T extends { id: string }>(
  registered: readonly T[],
  shipped: readonly T[],
): string[] {
  const platform = new Set<unknown>(shipped)
  return registered.filter((definition) => !platform.has(definition)).map((d) => d.id)
}
