import type {
  AgentRunContext,
  Logger,
  ToolSecretResolver,
  ToolSecretSubject,
} from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import {
  comparableCredentialInjectionName,
  credentialInjectionName,
  isReservedPlatformEnvKey,
  isToolchainEnvName,
  reservedEnvKeyMessage,
  toolchainEnvNameMessage,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// CAPABILITY CREDENTIALS for one container dispatch: take the capabilities the ENGINE resolved
// onto the run context, resolve each declared credential through the facade-wired
// `ToolSecretResolver`, and hand the values to the job body.
//
// TWO producers reach it, and one planner serves both because the rule that matters most is about
// the JOB rather than about either of them: every value here becomes an environment variable of
// ONE agent process, so two capabilities wanting different values under one variable name is a
// conflict no per-producer resolver could see.
//
//  - the step's GENERATIVE BINARY INTEGRATIONS (`stepOptions.binaryOutput.generatorIds`), which
//    authenticate what MAKES an artifact;
//  - the FOUNDATIONAL SERVICES this dispatch was briefed on, which authenticate what the run reads
//    and writes it THROUGH. Only a service the deployment registered in code can declare one.
//
// The split from the engine mirrors tool servers exactly, for the same reason: WHICH capabilities
// a step has is runtime-neutral engine state, while whether their credentials can be RESOLVED
// depends on the facade-wired resolver, which only this layer holds. And as with tool servers, the
// two channels stay apart: the prompt-facing half (what the agent is told, including the NAME of
// the variable each key arrives in) is the injected `.cat-context/` brief the engine already
// rendered, and only the VALUES travel here, on a dedicated top-level body field the
// agent-context snapshot's allow-list omits.
//
// Nothing here reports an unresolvable credential to the agent, and that is deliberate rather than
// an omission: every brief on this seam already states that an unset variable means the platform
// could not provide the key and the capability must not be called. The agent can SEE the variable;
// a second declaration from this side could only agree with the environment or contradict it.
// ---------------------------------------------------------------------------

/**
 * One `{ key, value }` env pair the harness injects into THIS JOB's agent process.
 *
 * `key` is the INJECTION name (`credentialInjectionName`), not necessarily what the resolver was
 * asked for. It has to be, because this is the variable the agent reads, and it is the same name
 * the brief tells it to read: both sides call that one helper so they cannot name different
 * variables.
 */
export interface CapabilitySecretJobSpec {
  key: string
  value: string
}

/** One credential as a producer states it: both names plus the disposition, never a value. */
interface DeclaredCredential {
  key: string
  envName?: string
  /** False ⇒ the capability works without it, so an unresolved one is not a misconfiguration. */
  required?: boolean
}

/**
 * One capability whose credentials this dispatch may resolve.
 *
 * The `subject` is the discriminated one the resolver port takes, carried rather than derived,
 * because it is what a per-workspace implementation scopes its lookup by: two registries mint
 * these ids independently and nothing stops a deployment registering a `file-storage` tool server
 * beside a `file-storage` foundational service.
 */
export interface CredentialSubject {
  subject: ToolSecretSubject
  /** Human label for the log line when a credential does not resolve. */
  label: string
  credentials: readonly DeclaredCredential[]
}

export interface ResolveCapabilitySecretsInput {
  context: AgentRunContext
  workspaceId: string
  blockId?: string
  /** Facade-wired; absent ⇒ nothing resolves, and the briefs' "unset means unavailable" holds. */
  resolveToolSecrets?: ToolSecretResolver
  logger?: Logger
}

/**
 * Everything this dispatch may be handed a credential for, in a stable order.
 *
 * Order is stable and generators come first only so the job body does not reshuffle between two
 * identical dispatches. It carries no precedence: a name two capabilities disagree about is
 * withheld from BOTH rather than served to whichever sorted first (see
 * {@link contestedInjectionNames}).
 */
function dispatchSubjects(context: AgentRunContext): CredentialSubject[] {
  const subjects: CredentialSubject[] = []
  for (const generator of context.binaryGenerators ?? []) {
    if (generator.credentials.length) {
      subjects.push({
        subject: { kind: 'binary-generator', id: generator.id },
        label: generator.label,
        credentials: generator.credentials,
      })
    }
  }
  for (const service of context.foundationalCredentials ?? []) {
    subjects.push({
      subject: { kind: 'foundational-service', id: service.id },
      label: service.name,
      credentials: service.credentials,
    })
  }
  return subjects
}

/**
 * Resolve every credential this dispatch's capabilities declare into job-body env pairs.
 *
 * Never throws and never fails a dispatch: a capability whose key does not resolve simply
 * contributes no pair, which is exactly the state the agent's brief tells it to report. Failing
 * the run instead would turn a missing key — the most ordinary misconfiguration there is — into a
 * run that produces nothing and explains nothing, when a run that does what it can and NAMES the
 * gap is strictly more useful.
 *
 * Every lookup one capability needs travels in ONE resolver call, which is the port's stated
 * contract (once per dispatch per subject) and not merely a saving: the per-workspace sealed-store
 * implementation re-reads and decrypts the whole workspace bag per call, so a key pair asked for
 * one name at a time pays that twice under an identical subject.
 *
 * Capabilities are resolved CONCURRENTLY, since their subjects are genuinely different. Order is
 * preserved by resolving a pre-built plan rather than pushing as results arrive.
 */
export async function resolveCapabilitySecrets(
  input: ResolveCapabilitySecretsInput,
): Promise<CapabilitySecretJobSpec[]> {
  const resolver = input.resolveToolSecrets
  const subjects = dispatchSubjects(input.context)
  if (!resolver || subjects.length === 0) return []
  const plans = planLookups(input, subjects)
  const resolved = await Promise.all(plans.map((plan) => resolveSubject(input, resolver, plan)))
  return resolved.flat()
}

/** One credential to resolve, with both names settled and every floor already applied. */
interface PlannedCredential {
  credential: DeclaredCredential
  key: string
  /** The variable the value is injected as, and the exact spelling the brief tells the agent. */
  envName: string
  /** The same name case-folded, which is the form a COLLISION between two of them is judged in. */
  comparableName: string
}

/** One capability's surviving credentials, which resolve together in a single call. */
interface SubjectPlan {
  subject: CredentialSubject
  credentials: PlannedCredential[]
}

/**
 * Decide, before any I/O, exactly which lookup each capability gets to make.
 *
 * Planning is separate from resolving because two of the three rules below are about the dispatch
 * AS A WHOLE rather than about one credential, and a rule of that shape cannot be applied by a
 * function that sees one credential at a time. It is also why the two producers share this
 * function rather than each running their own: a generator and a storage service that disagree
 * about one variable is exactly the case a per-producer planner cannot see.
 */
function planLookups(
  input: ResolveCapabilitySecretsInput,
  subjects: readonly CredentialSubject[],
): SubjectPlan[] {
  const admissible = subjects.map((subject) => ({
    subject,
    credentials: subject.credentials
      .filter((credential) => passesEnvNameFloors(input, subject, credential))
      .map((credential) => ({
        credential,
        key: credential.key,
        envName: credentialInjectionName(credential),
        comparableName: comparableCredentialInjectionName(credential),
      })),
  }))
  const contested = contestedInjectionNames(input, admissible)
  const claimed = new Set<string>()
  return admissible.map(({ subject, credentials }) => ({
    subject,
    credentials: credentials.filter((planned) => {
      // Contest is judged on the CASE-FOLDED name, because two spellings of one variable collide
      // wherever the environment is case-insensitive. The dedupe below is judged on the exact
      // name, because that is the string the brief tells the agent to read: dropping `acme_key`
      // as a duplicate of `ACME_KEY` would leave a variable named in the brief and set nowhere on
      // every platform that keeps them apart.
      if (contested.has(planned.comparableName)) return false
      // A name already claimed by an earlier capability is the SHARED-ACCOUNT case and nothing
      // else, because a contested name was dropped above: the claimant looks the same value up
      // under the same key, so the variable this capability reads is already being set to exactly
      // what it wanted. Asking a second time would only duplicate the round trip.
      if (claimed.has(planned.envName)) return false
      claimed.add(planned.envName)
      return true
    }),
  }))
}

/**
 * The injection names two capabilities want to mean DIFFERENT values, withheld from both.
 *
 * One vendor behind an image and a music endpoint legitimately shares a variable, and that case is
 * indistinguishable from a collision by the NAME alone: what separates them is whether the lookup
 * key behind the name is the same value. Where it is not, no arbitration can be right. Serving the
 * first claimant sets the variable the SECOND capability's brief tells the agent to read, so the
 * agent authenticates one thing with another's key, and every layer that could report it sees a
 * variable that is present and a call that failed. A pair loses a half the same way, with the
 * brief still telling the agent the two names belong together.
 *
 * So the value is withheld from everyone, which is the one disposition the briefs already describe
 * truthfully: an unset variable means the platform could not provide the credential, and both
 * capabilities are reported unavailable rather than one being quietly wrong. Boot refuses the pair
 * over every capability registry at once (`capability_injection_name_collision`), so a deployment
 * that registers both in code hears about it before serving; this guard still stands because a
 * mothership node validates nothing, and because only a dispatch knows which pair ever meets.
 */
function contestedInjectionNames(
  input: ResolveCapabilitySecretsInput,
  admissible: readonly SubjectPlan[],
): ReadonlySet<string> {
  // Keyed by the case-folded name and reported under the spelling that reached the dispatch: two
  // capabilities declaring `ACME_KEY` and `acme_key` for different keys are one variable on a
  // case-insensitive environment, which is where the wrong value would be read.
  const byName = new Map<string, { spelling: string; keys: Set<string>; owners: string[] }>()
  for (const { subject, credentials } of admissible) {
    const owner = `${subject.subject.kind}:${subject.subject.id}`
    for (const planned of credentials) {
      const entry = byName.get(planned.comparableName) ?? {
        spelling: planned.envName,
        keys: new Set<string>(),
        owners: [],
      }
      entry.keys.add(planned.key)
      if (!entry.owners.includes(owner)) entry.owners.push(owner)
      byName.set(planned.comparableName, entry)
    }
  }
  const contested = new Set<string>()
  for (const [comparableName, entry] of byName) {
    if (entry.keys.size < 2) continue
    contested.add(comparableName)
    input.logger?.warn(
      'capabilities disagree about what one injected variable holds; withholding it from all of them',
      {
        credentialEnvName: entry.spelling,
        capabilities: entry.owners,
        credentialKeys: [...entry.keys],
      },
    )
  }
  return contested
}

/**
 * The two name floors, applied per credential.
 *
 * Both are re-applied HERE rather than trusted from registration so they hold whatever a facade
 * wired, and because a MOTHERSHIP-MODE node boot-validates none of the definitions it resolves:
 * they arrive per dispatch over `/internal/*`, chosen by a process that is not this one, and the
 * environment they would be read from is a developer's own laptop.
 */
function passesEnvNameFloors(
  input: ResolveCapabilitySecretsInput,
  subject: CredentialSubject,
  credential: DeclaredCredential,
): boolean {
  // The platform's own configuration variables are never resolvable as a capability credential.
  // Only the LOOKUP key is held to it. The injection name reads nothing, so it gets the toolchain
  // rule below instead, which is what lets a capability keep a vendor's documented variable name
  // even when a platform prefix family covers it.
  if (isReservedPlatformEnvKey(credential.key)) {
    // Reported at WARN, not at the `debug` an optional missing key gets: this is never a
    // deployment's stated normal, and its fix is a declaration rather than a variable to set.
    input.logger?.warn(
      'capability declares a reserved credential key; the agent is told it is unavailable',
      {
        capability: `${subject.subject.kind}:${subject.subject.id}`,
        credentialKey: credential.key,
        detail: reservedEnvKeyMessage(credential.key),
      },
    )
    return false
  }
  // A value injected under a toolchain name reconfigures the agent's process instead of
  // authenticating a call. Registration refuses one; this is the mothership case again.
  const envName = credentialInjectionName(credential)
  if (isToolchainEnvName(envName)) {
    input.logger?.warn(
      'capability declares a toolchain injection name; the agent is told it is unavailable',
      {
        capability: `${subject.subject.kind}:${subject.subject.id}`,
        credentialEnvName: envName,
        detail: toolchainEnvNameMessage(envName),
      },
    )
    return false
  }
  return true
}

/** Resolve one capability's whole credential set in a single call, in declaration order. */
async function resolveSubject(
  input: ResolveCapabilitySecretsInput,
  resolver: ToolSecretResolver,
  plan: SubjectPlan,
): Promise<CapabilitySecretJobSpec[]> {
  if (plan.credentials.length === 0) return []
  const owner = `${plan.subject.subject.kind}:${plan.subject.subject.id}`
  // Distinct LOOKUP keys, because one stored value delivered under two injection names is an
  // allowed declaration and asking for the same key twice in one call is not.
  const keys = [...new Set(plan.credentials.map((planned) => planned.key))].map((key) => ({ key }))
  const resolved = await runBestEffort(
    input.logger ?? noopLogger,
    'resolve capability credentials',
    () =>
      resolver.resolve({
        workspaceId: input.workspaceId,
        ...(input.blockId ? { blockId: input.blockId } : {}),
        subject: plan.subject.subject,
        // The credentials are declared with no `header`, so the default env-var channel applies.
        // A capability here is called by the AGENT's own code, not by a client we configure, so a
        // header template would be a shape nothing here could act on. `required` rides the
        // declaration for the BRIEF's benefit, not this resolver's: the disposition for a missing
        // key is stated to the agent, never enforced by dropping something silently here.
        keys,
      }),
    { capability: owner },
  )
  const pairs: CapabilitySecretJobSpec[] = []
  for (const planned of plan.credentials) {
    const value = resolved?.[planned.key]
    if (value) {
      pairs.push({ key: planned.envName, value })
      continue
    }
    reportUnresolved(input, owner, planned)
  }
  return pairs
}

/**
 * An unresolved credential reported at the severity its DECLARATION earns.
 *
 * The two cases need different reactions and a single severity would train an operator to ignore
 * both. A required key that did not resolve is a misconfiguration that will cost this step its
 * capability; an optional one is a state the deployment declared as normal, so reporting it as a
 * warning would be crying wolf about a working endpoint.
 */
function reportUnresolved(
  input: ResolveCapabilitySecretsInput,
  capability: string,
  planned: PlannedCredential,
): void {
  if (planned.credential.required === false) {
    input.logger?.debug(
      'optional capability credential did not resolve; the agent is told to proceed without that value',
      { capability, credentialKey: planned.key },
    )
    return
  }
  input.logger?.warn('capability credential did not resolve; the agent is told it is unavailable', {
    capability,
    credentialKey: planned.key,
  })
}
