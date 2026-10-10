import type { Logger, ToolSecretResolver } from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import type { CapabilityCredentialsService } from '@cat-factory/integrations'
import { createEnvToolSecretResolver } from './toolServers.js'

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

/**
 * A resolver that answers nothing, for the one composition that legitimately has nothing to ask:
 * a deployment that declared its chain store-ONLY and has no store to compose. Named rather than
 * expressed as an empty {@link composeToolSecretResolvers} call, so the state reads as the refusal
 * it is at the one site that can produce it.
 */
const emptyToolSecretResolver: ToolSecretResolver = { resolve: async () => ({}) }

/**
 * Which composition-time misconfigurations this process has already reported.
 *
 * {@link buildToolSecretChain} runs once per CONTAINER BUILD, which on the Worker is once per
 * request, per cron tick and per queue message. What it reports is a standing fact about the
 * DEPLOYMENT rather than an event, so repeating it per invocation buries the one line that names
 * it. Reported once per process (per isolate on the Worker), which is the cadence
 * `validateRegistrationsOnce` already sets for the sibling registration checks: still visible in a
 * fresh log, never a flood.
 *
 * Not a counter: a configuration mistake has no rate to watch, and a bounded dimension for it
 * would be the deployment's own wiring, which is one value.
 */
const reportedChainProblems = new Set<string>()

/** True the FIRST time this process is asked about `problem`, false forever after. */
function shouldReportChainProblem(problem: string): boolean {
  if (reportedChainProblems.has(problem)) return false
  reportedChainProblems.add(problem)
  return true
}

/**
 * Forget which composition-time misconfigurations have been reported.
 *
 * For tests that exercise the reports: they share one process, so the once-per-process guard above
 * would otherwise let the first case run silence every case after it. Deliberately NOT exported
 * from the package index, since a deployment has no business re-arming a boot warning.
 */
export function resetToolSecretChainReports(): void {
  reportedChainProblems.clear()
}

/**
 * A composed capability-credential chain, and the description of what it CONSULTS.
 *
 * The two travel together because the operator surface has to describe the real chain rather than
 * re-assert a default beside it: whether a blank row in the credential checklist may still resolve
 * is a property of what the facade composed, and the checklist rendered "the deployment's
 * environment may still answer for this key" for a whole release while a deployment could already
 * replace that environment resolver wholesale. One function decides both, so they cannot disagree.
 */
export interface ToolSecretChain {
  /** What the dispatch path asks. */
  resolver: ToolSecretResolver
  /**
   * Whether the deployment ENVIRONMENT answers behind the workspace store.
   *
   * Undefined when a deployment supplied its own resolver: it replaced the chain, and nothing here
   * knows whether what it put there reads the environment. That is a third state on purpose. See
   * `capabilityCredentialsViewSchema.environmentFallback`.
   */
  environmentFallback?: boolean
}

/**
 * The two fields a {@link ToolSecretChain} contributes to a facade's `ServerContainer`.
 *
 * Structurally typed rather than a `Pick<ServerContainer, …>` so this module keeps no dependency on
 * the HTTP layer; the result is assignable to the container either way.
 */
export interface ToolSecretContainerFields {
  /** The composed chain the tool-server PROBE resolves through. */
  toolSecretResolver: ToolSecretResolver
  /** What sits behind the store, when it can be described. Omitted when it cannot. */
  toolSecretEnvironmentFallback?: boolean
}

/**
 * Project a composed chain onto the container fields every facade surfaces.
 *
 * ONE function for both facades, for the reason `buildToolSecretChain` itself exists: the resolver
 * and the DESCRIPTION of what sits behind it have to travel together, and each facade assembling
 * the pair by hand is exactly the shape that lets the runtimes drift about it. The conditional
 * spread is the part worth centralising: `undefined` must be ABSENT rather than present-and-
 * undefined, because the credential checklist renders three states off that distinction and a
 * facade that spread the key unconditionally would turn "cannot be described" into a rendered guess.
 */
export function toolSecretContainerFields(chain: ToolSecretChain): ToolSecretContainerFields {
  return {
    toolSecretResolver: chain.resolver,
    ...(chain.environmentFallback === undefined
      ? {}
      : { toolSecretEnvironmentFallback: chain.environmentFallback }),
  }
}

export interface ToolSecretChainInput {
  /**
   * A deployment's own resolver, from its facade's `createToolSecretResolver`. Present ⇒ it
   * REPLACES the chain rather than being wrapped by it, which is the documented meaning of that
   * seam: a deployment reaching for the port wants its own precedence, not ours around it.
   */
  custom?: ToolSecretResolver | undefined
  /** The per-workspace sealed store, when the deployment has one (needs `ENCRYPTION_KEY`). */
  credentials?: CapabilityCredentialsService | undefined
  /** This process's own configured environment, read per declared key. */
  env: Record<string, unknown> | undefined
  /**
   * Whether the deployment environment answers BEHIND the store. Defaults to true, which is the
   * shape a single-tenant install, a local checkout and a CI environment all want and the one an
   * operator already has wired.
   *
   * A multi-tenant deployment sets it false so a workspace that has stored nothing resolves
   * nothing, rather than silently authenticating every tenant's runs as whoever set the variable.
   * Whether a HOSTED deployment should default this way is a product call, so the default here
   * does not make it.
   */
  environmentFallback?: boolean | undefined
  logger?: Logger
}

/**
 * Compose the capability-credential chain a facade dispatches with, and say what it consults.
 *
 * The ONE composition site for all three facades. It was two (Node's and the Worker's executor
 * builders each assembled their own), which is exactly the shape that lets the runtimes drift
 * about a precedence rule, and neither could be read by the surface that has to describe it.
 */
export function buildToolSecretChain(input: ToolSecretChainInput): ToolSecretChain {
  const logger = input.logger ?? noopLogger
  if (input.custom) {
    // A deployment that set BOTH has made a declaration this composition cannot honour: its own
    // resolver replaced the chain, so there is no fallback of ours left to keep or drop. Said out
    // loud rather than dropped, the same rule that governs a capability an agent asked for and the
    // harness could not serve. The operator otherwise reads a store-only deployment off their own
    // configuration while the resolver they wrote answers whatever it answers.
    if (
      input.environmentFallback !== undefined &&
      shouldReportChainProblem('custom-resolver-ignores-fallback')
    ) {
      logger.warn(
        'capabilityCredentialEnvironmentFallback is ignored: this deployment supplied its own ' +
          'ToolSecretResolver, which REPLACES the platform chain rather than sitting behind it, ' +
          'so whether the environment answers is decided inside that resolver. Drop the option, ' +
          'or fold the behaviour it asks for into the resolver.',
        { environmentFallback: input.environmentFallback },
      )
    }
    return { resolver: input.custom }
  }

  const environmentFallback = input.environmentFallback !== false
  const resolvers: ToolSecretResolver[] = []
  if (input.credentials) {
    resolvers.push(createWorkspaceToolSecretResolver({ credentials: input.credentials, logger }))
  }
  if (environmentFallback) resolvers.push(createEnvToolSecretResolver(input.env))

  if (resolvers.length === 0) {
    // Store-only was asked for and there is no store: every declared credential is unresolvable,
    // and every capability that declares one reports itself unavailable to its agent. Said out
    // loud at composition, because the run-path symptom names the capability rather than the
    // deployment's own configuration.
    if (shouldReportChainProblem('store-only-without-store')) {
      logger.error(
        'capability credentials resolve to nothing: the deployment declared a store-only chain ' +
          'but has no credential store (needs ENCRYPTION_KEY). Every declared tool-server and ' +
          'generative-integration credential will be reported unavailable to its agent.',
      )
    }
    return { resolver: emptyToolSecretResolver, environmentFallback }
  }
  return { resolver: composeToolSecretResolvers(resolvers, logger), environmentFallback }
}
