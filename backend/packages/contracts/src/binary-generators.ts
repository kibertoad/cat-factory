import * as v from 'valibot'
import { binaryGeneratorCapabilitySchema } from './binary-capabilities.js'
import { binaryModalitySchema, mediaTypeSchema } from './binary-modalities.js'
import { uploadApiContractSchema } from './foundational-services.js'
import {
  isReservedPlatformEnvKey,
  isToolchainEnvName,
  reservedEnvKeyMessage,
  toolchainEnvNameMessage,
} from './reserved-env-keys.js'

// ---------------------------------------------------------------------------
// Wire vocabulary for GENERATIVE BINARY INTEGRATIONS — the third-party (or in-house) APIs a
// binary-generating agent kind calls to PRODUCE its deliverable: an image generator, a
// music/speech generator, a video generator.
//
// This is the missing half of `binary-outputs.ts`. That module answers "where does a generated
// artifact GO" (a foundational service the org runs, carrying the `asset-storage` capability);
// this one answers "what MAKES it". The two are deliberately separate registries because they
// are separate facts about an org: the storage estate is shared infrastructure every designed
// system consumes, while a generation integration is a vendor a deployment buys and points at
// specific steps. Modelling a generator as a foundational service would put a metered vendor
// API into the catalog an Architect designs AGAINST, where it would be offered to every design
// step as something to build on.
//
// A generator is registered in a deployment's CODE, on the app-owned `BinaryGeneratorRegistry`
// (kernel), exactly as it registers agent kinds, gates, pipelines or its foundational estate —
// so it needs no table, no migration and no UI, and both runtime facades get identical
// behaviour by building the same registry.
// ---------------------------------------------------------------------------

const slug = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lower-kebab slug'),
)

/**
 * ONE credential a generative integration needs, declared by NAME only, never a value.
 *
 * The value is resolved per dispatch through the facade-wired `ToolSecretResolver` port (the
 * same port a tool server's credentials go through) and written straight onto the job body,
 * where the harness injects it into THIS JOB's agent environment. It never reaches
 * `AgentRunContext`, a prompt, or the telemetry snapshot: only the key NAME does, because the
 * agent has to know which variable to read.
 *
 * An integration declares a LIST of these ({@link binaryGeneratorDefinitionSchema}'s
 * `credentials`), because a vendor's account is not always one string. HTTP Basic over a
 * key/secret pair is the ordinary case that breaks a single field, and it is common enough to be
 * a shape rather than one vendor's eccentricity. Under one field the two halves have to be
 * colon-joined into a single variable, which rotates them together, hands the operator one
 * checklist row where their vendor console shows two values, and turns a mis-joined value into a
 * 401 indistinguishable from a wrong key.
 */
export const binaryGeneratorCredentialSchema = v.object({
  /**
   * The credential's LOOKUP key: what the secret resolver is asked for, and what a workspace
   * stores its own value under. Also the ENVIRONMENT VARIABLE the agent reads it from unless
   * {@link envName} says otherwise, so it must be a valid POSIX variable name either way: a
   * generator declaring `x-rd-token` would resolve fine and then be dropped by the harness's env
   * validation, which is a silent "the integration just 401s" at run time.
   *
   * It may NOT name a variable the platform's own configuration owns
   * ({@link isReservedPlatformEnvKey}). The resolver reads the key off the deployment's
   * environment and the value is injected into an agent process, so an integration declaring
   * `ENCRYPTION_KEY` would hand a prompt-injectable agent the deployment's master sealing key.
   * Refused here so a deployment learns at boot, and again at dispatch, since a mothership-mode
   * node boot-validates none of the definitions it resolves.
   */
  key: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(128),
    v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name'),
    v.check(
      (key) => !isReservedPlatformEnvKey(key),
      (issue) => reservedEnvKeyMessage(String(issue.input)),
    ),
  ),
  /**
   * The environment variable the value is injected as, when that differs from {@link key}. This
   * is the name the agent is told to read, and it is what a vendor SDK that auto-reads its own
   * documented variable needs.
   *
   * Held to the toolchain rule rather than the reserved-platform one, because it reads nothing:
   * the floor above is about what may be READ off the deployment's environment, and an injection
   * name only decides what a variable is called inside this job's agent process. That is what lets
   * an integration keep a vendor's documented name even when a platform prefix family covers it.
   */
  envName: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(128),
      v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name'),
      v.check(
        (name) => !isToolchainEnvName(name),
        (issue) => toolchainEnvNameMessage(String(issue.input)),
      ),
    ),
  ),
  /**
   * How the integration expects the credential to be presented (`X-RD-Token: <value>`,
   * `Authorization: Bearer <value>`). Folded into the brief verbatim: the agent writes the
   * request itself, and a key with no stated header is a key it has to guess the use of.
   */
  usage: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
  /**
   * When true (the default), an integration whose credential does not resolve is reported to
   * the agent as UNAVAILABLE rather than offered. Set false only for an endpoint that genuinely
   * works unauthenticated — an agent handed an API whose first call 401s burns a run
   * discovering it.
   */
  required: v.optional(v.boolean()),
})
export type BinaryGeneratorCredential = v.InferOutput<typeof binaryGeneratorCredentialSchema>

/**
 * The two names a credential carries, which is all the fallback below reads.
 *
 * Structural rather than {@link BinaryGeneratorCredential} itself, because the DISPATCH projection
 * carries a narrower shape (kernel's `ResolvedBinaryGeneratorCredential`, which drops `usage` and
 * every other prose field the container executor has no use for) and would otherwise have to
 * either widen or re-spell the fallback. A parameter type nothing outside the two names can
 * satisfy is what makes the "one place" claim below enforceable rather than aspirational.
 */
export interface BinaryCredentialNames {
  key: string
  envName?: string
}

/**
 * The environment variable one credential arrives as: its {@link BinaryGeneratorCredential.envName}
 * when it declares one, else its lookup key.
 *
 * The ONE place that fallback is written, because three layers apply it (the schema's uniqueness
 * check below, the dispatch-time resolver that keys the job body, and the brief that tells the
 * agent which variable to read) and a copy that drifted would name a variable that is never set:
 * an integration reported as unavailable on every run, with nothing to see at either end.
 */
export function binaryCredentialInjectionName(credential: BinaryCredentialNames): string {
  return credential.envName ?? credential.key
}

/**
 * Whether every credential in a declaration arrives as its own variable.
 *
 * Exported so the boot check and the schema share one implementation rather than agreeing by
 * hand. Duplicate LOOKUP keys are deliberately allowed: an integration wanting one stored value
 * delivered under two names is odd but honest, and nothing is lost. A duplicate INJECTION name
 * loses a value, which is why only that one is refused.
 */
export function uniqueCredentialInjectionNames(
  credentials: readonly BinaryGeneratorCredential[],
): boolean {
  const names = credentials.map(binaryCredentialInjectionName)
  return new Set(names).size === names.length
}

/**
 * A generative binary integration a deployment registers in code.
 *
 * Shaped like a foundational service on purpose — identity, prose, and API contracts in the
 * SAME `uploadApiContractSchema` vocabulary — so one contract renderer serves both and a
 * deployment writes one kind of definition. What it adds is what a GENERATOR has and a shared
 * service does not: the content types it produces, and the credential it needs.
 */
export const binaryGeneratorDefinitionSchema = v.object({
  /** Stable id, referenced by a step's `stepOptions.binaryOutput.generatorIds`. */
  id: slug,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  /** One line, shown in the picker and the agent's brief. */
  summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400)),
  /**
   * What it is good at and what it is NOT for — style, resolution/length limits, cost profile.
   * The half a model needs to pick between two registered generators of the same modality.
   */
  description: v.pipe(v.string(), v.trim(), v.maxLength(20_000)),
  /**
   * The content types it produces. At least one: a generator that produces nothing is not a
   * generator, and an empty list would make it match every step's requirements by vacuity.
   */
  modalities: v.pipe(v.array(binaryModalitySchema), v.minLength(1)),
  /**
   * The concrete media types it can emit (`image/png`, `audio/mpeg`), when the integration
   * pins them down. Absent ⇒ only the coarse {@link modalities} are known, which the brief
   * states as such rather than implying every format of that modality is available.
   */
  mediaTypes: v.optional(v.array(mediaTypeSchema)),
  /**
   * What it can be ASKED FOR while generating: a reference image, a mask edit, a seed, a
   * transparent background (see `binary-capabilities.ts`). This is what decides which per-step
   * generation options the builder offers, what the brief tells the agent it may send, and which
   * option requirements admission refuses.
   *
   * Absent is a DOCUMENTED state and the honest default for a definition nobody has audited: it
   * means "only the coarse facts are known", exactly as an absent {@link mediaTypes} does, so
   * every option requirement against it is reported as unverifiable rather than refused. Declare
   * it once the endpoint's parameters are actually known, and the step gains a real check.
   *
   * The vocabulary is closed and deliberately narrow: a capability belongs here only when the
   * platform exposes something because of it. A vendor knob nobody else has stays in
   * {@link guidance}, where a sentence can say what it does.
   */
  capabilities: v.optional(v.array(binaryGeneratorCapabilitySchema)),
  /**
   * The API's base URL. Stated to the agent so it does not have to infer one from the contract,
   * and refused at registration unless it is `https` (or loopback) — the credential above rides
   * this request.
   */
  endpoint: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048))),
  /**
   * Operating notes folded into the agent's brief verbatim — polling an async job, the shape of
   * a returned payload (base64 vs a signed URL), a rate limit worth respecting. This is where a
   * deployment puts the knowledge that would otherwise be discovered once per run.
   */
  guidance: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(20_000))),
  /**
   * The credentials it authenticates with, by name. Absent or empty ⇒ the integration is called
   * unauthenticated, which the brief states as such rather than leaving the agent to guess.
   *
   * A LIST rather than one, because a vendor account is not always one string: HTTP Basic over a
   * key/secret pair needs both halves, and every other layer this travels through was already
   * plural (the `ToolSecretResolver` port takes `keys`, a tool server declares `credentials`, the
   * checklist keys its rows by `(subject, id, key)`, and the job body carries pairs). The single
   * field was the one singular link in that chain, and it bought nothing.
   *
   * INJECTION NAMES must be distinct, which is what {@link uniqueCredentialInjectionNames}
   * refuses. The job body is keyed by the variable each value arrives as, so two entries naming
   * one variable do not conflict loudly: one silently wins, and the integration authenticates
   * with half of a pair.
   */
  credentials: v.optional(
    v.pipe(
      v.array(binaryGeneratorCredentialSchema),
      v.maxLength(8),
      // Wrapped rather than passed by reference: the helper takes a `readonly` array (it is the
      // shape every other caller holds) and valibot infers a check's input as the pipe's own
      // mutable item type, which will not accept it.
      v.check(
        (credentials) => uniqueCredentialInjectionNames(credentials),
        'each credential must arrive as its own environment variable',
      ),
    ),
  ),
  /**
   * The integration's API contract documents, in the same formats the foundational catalog
   * accepts. Injected as `.cat-context/` files beside the brief, so the agent calls the
   * operations the contract declares instead of inventing them.
   */
  contracts: v.optional(v.array(uploadApiContractSchema)),
})
export type BinaryGeneratorDefinition = v.InferOutput<typeof binaryGeneratorDefinitionSchema>

/**
 * The ways `definition` fails {@link binaryGeneratorDefinitionSchema}, as readable lines — empty
 * when it would be accepted.
 *
 * Exists for the same reason `foundationalServiceDefinitionIssues` does: the backend layers that
 * hold a deployment's CODE-registered definitions to this shape (kernel, orchestration's boot
 * validation) cannot depend on valibot, and re-stating the rules in a second place is how a
 * registration ends up accepted where an equivalent one is refused.
 */
/**
 * A registered integration as the WIRE carries it to the SPA (the workspace snapshot's
 * `binaryGenerators`), so the pipeline builder can offer a step's `generatorIds` from the same
 * set run admission validates against instead of asking a human to type an id.
 *
 * IDENTITY ONLY, and the omissions are the point. The credential's key NAME is left out — the
 * picker has no use for it, and a workspace VIEWER has no business learning which environment
 * variables the deployment sets. So are the contracts and the endpoint: they are the agent's
 * interface to the integration, delivered as injected `.cat-context/` files at dispatch, and
 * nothing a person picking from a list needs.
 */
export const registeredBinaryGeneratorSchema = v.object({
  id: slug,
  name: v.string(),
  summary: v.string(),
  /** What it produces — what the builder checks a step's declared content types against. */
  modalities: v.array(binaryModalitySchema),
  /** The concrete formats it pins down, when it declares any. Shown as detail, never a filter. */
  mediaTypes: v.optional(v.array(mediaTypeSchema)),
  /**
   * What it can be asked for while generating. Unlike the two fields above this one does more
   * than label a candidate: the builder shows a step's generation options against it, so a
   * projection that omitted it would leave the SPA offering a reference-image field for an
   * endpoint that takes no image, and the refusal would arrive at run start.
   *
   * Still identity-grade, so it stays inside the rule the omissions here follow: it is what the
   * integration IS, not how to reach it. The credential key name, the endpoint and the contracts
   * remain absent, because a workspace viewer has no business learning them.
   */
  capabilities: v.optional(v.array(binaryGeneratorCapabilitySchema)),
})
export type RegisteredBinaryGenerator = v.InferOutput<typeof registeredBinaryGeneratorSchema>

export function binaryGeneratorDefinitionIssues(definition: unknown): string[] {
  const parsed = v.safeParse(binaryGeneratorDefinitionSchema, definition)
  if (parsed.success) return []
  return parsed.issues.map((issue) => {
    const path = issue.path?.map((segment) => String(segment.key)).join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
}
