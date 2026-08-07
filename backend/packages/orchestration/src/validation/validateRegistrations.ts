import type { AgentKindRegistry } from '@cat-factory/agents'
import { INLINE_ENGINE_SYSTEM_PROMPTS, runsInContainer } from '@cat-factory/agents'
import type {
  AgentKind,
  BinaryGeneratorRegistry,
  FoundationalServiceRegistry,
  GateRegistry,
  InitiativePresetRegistry,
  McpSecretRef,
  McpServerDefinition,
  PipelineRegistry,
  PromptFragmentRegistry,
  PromptFragmentSource,
  TaskTypeRegistry,
} from '@cat-factory/kernel'
import {
  CI_FIXER_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  FIXER_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  MCP_OAUTH_DEFAULT_HEADER,
  MCP_SUPPORTED_HARNESSES,
  TOOL_SERVER_BUDGET,
  describeFoundationalProblem,
  isAllowedMcpHttpUrl,
  isValidMcpServerId,
  isValidMcpToolName,
  mcpServableHarnesses,
  seedPipelines,
  stubGateContext,
  toolServerDeclaredBytes,
  validateFoundationalDefinition,
} from '@cat-factory/kernel'
import {
  type BinaryGeneratorDefinition,
  type CustomTaskType,
  type DescriptorField,
  binaryGeneratorDefinitionIssues,
  descriptorConditionHasPredicate,
  duplicatedDescriptorSectionCaptions,
  foundationalServiceDefinitionIssues,
  isEnvVariableName,
  isNamespacedId,
  isReservedPlatformEnvKey,
  isToolchainEnvName,
  modalitiesOfMediaType,
  reservedEnvKeyMessage,
  toolchainEnvNameMessage,
  isValidResultViewId,
  RESULT_VIEW_ID_SET,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Boot-time validation of the deployment's registered extensions (agent kinds, gates,
// pipelines). A typo'd gate `helperKind`, an unknown `resultView`, or a pipeline naming a
// kind that doesn't exist used to surface mid-run (a failed dispatch) or silently (a prose
// fallback). `validateRegistrations()` turns those into a LOUD startup error instead — a
// facade calls it once after all `register*` side-effect imports + provider wiring, before
// serving, so a misconfigured deployment fails fast at boot.
//
// This lives in orchestration because it cross-checks the gate registry (kernel) against the
// agent-kind registry (@cat-factory/agents) and the pipeline registry — only orchestration
// depends on all three.
// ---------------------------------------------------------------------------

/** Built-in container helper kinds a gate may escalate to (handled by the executor/harness,
 * not the custom-kind registry). A gate `helperKind` is valid if it's one of these or a
 * registered container-capable kind. */
const BUILT_IN_HELPER_KINDS: ReadonlySet<string> = new Set([
  CI_FIXER_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  // The human-review gate escalates to the `fixer` (a built-in container coding agent, also
  // the Tester's helper) to address review comments.
  FIXER_AGENT_KIND,
])

/** A single problem found during validation. `error` aborts boot; `warn` is logged only. */
export interface RegistrationProblem {
  severity: 'error' | 'warn'
  code: string
  message: string
}

/**
 * Everything this validator reads, as ONE object a facade satisfies by passing its CONTAINER.
 *
 * It used to be seven optional fields on the options object, hand-listed at each call site, and
 * that shape is what put the local MOTHERSHIP boot two registries behind the others: it passed
 * five of them, its own comment claimed parity with `start()`, and a custom task type naming an
 * unregistered pipeline booted clean there while failing on the Postgres path. A hand-list has no
 * failure mode other than being incomplete, and nothing can tell that it is.
 *
 * The container carries every one of these as a required field, so `{ registries: container }`
 * type-checks and cannot be partial. A registry added to the validator therefore reaches all three
 * facades with no call-site edit at all.
 */
export interface ValidatedRegistries {
  /**
   * The app-owned agent-kind registry to validate (the facade's injected instance). Required:
   * without it there are no registered kinds to cross-check the gates/pipelines against.
   */
  agentKindRegistry: AgentKindRegistry
  /**
   * The app-owned gate registry to validate (the facade's injected instance, the SAME one it
   * threads through `CoreDependencies.gateRegistry`). Required: the gate-helper + pipeline-kind
   * cross-checks read the registered gates from it rather than a module global.
   */
  gateRegistry: GateRegistry
  /**
   * The app-owned pipeline registry to validate (the facade's injected instance, the SAME one it
   * threads through `CoreDependencies.pipelineRegistry`). Optional: when omitted, no
   * deployment-registered pipelines are cross-checked (the pipeline-kind check still needs
   * `knownAgentKinds`). A facade that registers custom pipelines passes it so a pipeline naming a
   * nonexistent kind fails at boot rather than mid-run.
   */
  pipelineRegistry?: PipelineRegistry
  /**
   * The app-owned custom task-type registry to validate (the facade's injected instance — the
   * SAME one it threads through `CoreDependencies.taskTypeRegistry`). Optional: when omitted, no
   * task-type checks run. A facade that registers custom task types passes it so a malformed id,
   * a bad `formPanel`, or a `defaultPipelineId` naming a nonexistent pipeline fails at boot.
   */
  taskTypeRegistry?: TaskTypeRegistry
  /**
   * The app-owned initiative-preset registry to validate (the facade's injected instance — the SAME
   * one it threads through `CoreDependencies.initiativePresetRegistry`). Optional: when omitted, no
   * preset create form is checked. A facade passes it so a preset whose form cannot be filled fails
   * at boot rather than rendering an empty picker (or an invisible field) in the create modal.
   */
  initiativePresetRegistry?: InitiativePresetRegistry
  /**
   * The app-owned foundational-service registry to validate (the facade's injected instance —
   * the SAME one it threads through `CoreDependencies.foundationalServiceRegistry`). Optional:
   * when omitted, no deployment-registered services are checked. A facade that registers its
   * estate in code passes it, so a malformed definition or an unparseable contract document
   * fails at boot rather than reaching an Architect as an empty catalog entry.
   */
  foundationalServiceRegistry?: FoundationalServiceRegistry
  /**
   * The app-owned generative-binary-integration registry to validate (the facade's injected
   * instance — the SAME one it threads through `CoreDependencies.binaryGeneratorRegistry`).
   * Optional: when omitted, no registered integration is checked. A facade that registers any
   * passes it, so a malformed definition, an unusable credential name or a cleartext endpoint
   * fails boot rather than surfacing as a refused run or an unexplained 401 mid-generation.
   */
  binaryGeneratorRegistry?: BinaryGeneratorRegistry
  /**
   * The app-owned prompt-fragment registry (the facade's injected instance, the SAME one it
   * threads through `CoreDependencies.promptFragmentRegistry`). Optional: when omitted, a task
   * type's fragment ids are NOT checked, because this process then has no pool to check them
   * against and an empty one would report every id as unresolvable.
   */
  promptFragmentRegistry?: PromptFragmentRegistry
  /**
   * The RESOLVED pool source, read for one bit: whether the registry above is the pool a run will
   * actually fold. On a mothership-mode node it is not, and the id checks stand down rather than
   * judging the mothership's standards against this build's registry. Optional, and absent means
   * the registry speaks for itself.
   *
   * Named as the CONTAINER names it, like every other member here, because the one call shape is
   * `registries: container` and a field this type spells differently is a field that silently
   * never arrives.
   */
  promptFragments?: PromptFragmentSource
}

/** Options for {@link collectRegistrationProblems} / {@link validateRegistrations}. */
export interface ValidateRegistrationsOptions {
  /** Every app-owned registry the checks read. A facade passes its container. */
  registries: ValidatedRegistries
  /** Override the canonical result-view id set (defaults to contracts' {@link RESULT_VIEW_ID_SET}). */
  knownResultViewIds?: ReadonlySet<string>
  /** Built-in helper kinds a gate may escalate to (defaults to ci-fixer/conflict-resolver/on-call). */
  builtInHelperKinds?: ReadonlySet<string>
  /**
   * The known built-in agent-kind ids, for validating a registered pipeline's `agentKinds`.
   * The backend has no canonical runtime catalog of built-in kinds, so a pipeline-kind check
   * is only run when this is supplied (else built-in kinds like `coder` would false-positive);
   * unknown kinds are then ERRORS. Omitted ⇒ the pipeline-kind check is skipped.
   */
  knownAgentKinds?: ReadonlySet<string>
  /**
   * Sink for `warn`-severity problems (orchestration is runtime-neutral, so it never touches
   * `console`/a logger directly — the facade passes its logger). Omitted ⇒ warnings are dropped
   * (errors still throw).
   */
  onWarn?: (problem: RegistrationProblem) => void
  /**
   * Raise a `warn` to an ERROR: return `true` and the problem joins the aggregated boot failure
   * instead of the log.
   *
   * The severities here are set by ONE bar: boot ERRORS on what is fully knowable from a
   * registration and WARNS only where it structurally cannot see the answer (ADR 0040). That bar is
   * about what the PLATFORM can know, and for one warn in particular the DEPLOYMENT knows more.
   * `task_type_unknown_fragment` fires for two causes it cannot separate: a typo in a code-owned id,
   * and an account/workspace-tier id that merges per workspace at run time and is invisible at boot.
   * A deployment whose operations reference only fragments it registers itself knows the second
   * cause cannot apply to it, and for that deployment the warn names a real defect: part of an
   * operation's standing guidance silently never enters a run, and for a `conditionalFragmentIds`
   * entry it goes missing only for the cases matching the condition.
   *
   * So the SEVERITY is platform judgement and the DISPOSITION is deployment policy, which is the
   * split this hook exists to express. It takes the whole problem rather than a list of codes on
   * purpose: a deployment can escalate one code, a prefix, or everything, and a warn added later is
   * covered by a predicate that never mentioned it.
   *
   * Escalated problems are collected and thrown TOGETHER with the genuine errors, so a boot failure
   * still names every problem at once. A predicate that throws is a bug in the predicate and
   * propagates unchanged, rather than being swallowed into a warn about warnings.
   */
  escalateWarning?: (problem: RegistrationProblem) => boolean
}

/**
 * Collect every registration problem (does not throw). Useful for tests and for callers that
 * want to log warnings without aborting. {@link validateRegistrations} throws on any `error`.
 */
export function collectRegistrationProblems(
  opts: ValidateRegistrationsOptions,
): RegistrationProblem[] {
  const knownResultViewIds = opts.knownResultViewIds ?? RESULT_VIEW_ID_SET
  const builtInHelperKinds = opts.builtInHelperKinds ?? BUILT_IN_HELPER_KINDS
  const registry = opts.registries.agentKindRegistry
  const problems: RegistrationProblem[] = []

  const agentKinds = registry.all()
  const registeredKindIds = new Set(agentKinds.map((d) => d.kind))
  const gateFactories = opts.registries.gateRegistry.factories()
  const gateKinds = new Set(gateFactories.map((g) => g.kind))

  // 1. Every gate's helperKind must resolve to a registered container-capable kind or a
  //    built-in helper. The factory is a pure constructor, so we build it with a stub context
  //    just to read its declared helperKind.
  for (const { kind, factory } of gateFactories) {
    let helperKind: string
    try {
      helperKind = factory(stubGateContext()).helperKind
    } catch (err) {
      problems.push({
        severity: 'error',
        code: 'gate_factory_threw',
        message: `Gate "${kind}" factory threw while validating: ${(err as Error).message}`,
      })
      continue
    }
    const helperOk =
      builtInHelperKinds.has(helperKind) ||
      (registeredKindIds.has(helperKind) && registry.requiresContainer(helperKind))
    if (!helperOk) {
      problems.push({
        severity: 'error',
        code: 'gate_helper_unresolved',
        message:
          `Gate "${kind}" escalates to helperKind "${helperKind}", which is neither a ` +
          `built-in helper nor a registered container-capable agent kind. Register the helper ` +
          `(a container surface) or fix the helperKind.`,
      })
    }
  }

  // 2. Every registered kind's presentation.resultView must be a known BUILT-IN view id or a
  //    consumer-namespaced id (`<ns>:<name>`, paired to a deployment-registered component on
  //    the SPA). A bare unknown id is a typo → error (the SPA would silently fall back to prose).
  for (const def of agentKinds) {
    const resultView = def.presentation?.resultView
    if (resultView !== undefined && !isValidResultViewId(resultView, knownResultViewIds)) {
      problems.push({
        severity: 'error',
        code: 'unknown_result_view',
        message:
          `Agent kind "${def.kind}" declares resultView "${resultView}", which is neither a known ` +
          `built-in result view nor a namespaced consumer id (<ns>:<name>). Use one of: ` +
          `${[...knownResultViewIds].join(', ')} — or a namespaced id paired with a frontend component.`,
      })
    }
  }

  // 3. Coherence (warn): a kind with postOps that has an agent step which is NOT structured
  //    output likely can't feed those post-ops from `result.custom`. Heuristic, so a warning.
  problems.push(...checkPostOpsStructuredOutput(agentKinds, registry))

  // 4. Pipeline kinds (only when a built-in catalog is supplied — see option doc), and pipeline
  //    RETIREMENTS that name a still-live pipeline (an inert `retire()` call).
  problems.push(...checkPipelineKinds(opts, registeredKindIds, gateKinds, builtInHelperKinds))
  problems.push(...checkPipelineRetirements(opts))

  // 5. Custom task types (only when a task-type registry is supplied).
  problems.push(...checkCustomTaskTypes(opts))

  // 5b/5c. The OTHER two surfaces that declare a form over the same vocabulary, held to the same
  //        bar by the same checker: an initiative preset's create form, and a registered gate's
  //        per-step config form.
  problems.push(...checkInitiativePresetForms(opts))
  problems.push(...checkGateConfigForms(opts))

  // 6. Agent capabilities: the skills + tool servers declared for each kind.
  problems.push(...checkAgentCapabilities(registry))

  // 7. Agent-kind VARIANTS: their base kind must exist and they must actually change the prompt.
  problems.push(...checkAgentKindVariants(opts, registeredKindIds))

  // 8. Deployment-registered FOUNDATIONAL SERVICES (only when a registry is supplied).
  problems.push(...checkFoundationalServices(opts))

  // 9. Deployment-registered GENERATIVE BINARY INTEGRATIONS (only when a registry is supplied).
  problems.push(...checkBinaryGenerators(opts))

  // 10. Deployment-registered PROMPT FRAGMENTS (only when a registry is supplied).
  problems.push(...checkPromptFragments(opts))

  return problems
}

/**
 * Section 10 of {@link collectRegistrationProblems}: a code-registered prompt fragment that carries
 * a `documentRef`.
 *
 * The registration is ACCEPTED today, faithfully carried through the catalog merge with
 * `docViaWorkspaceId: null`, put on the wire, and rendered by the library UI with a
 * `fragments.catalog.live` badge NAMING the source. And then `resolveDocumentBody` refuses it:
 * `entry.tier === 'builtin'` short-circuits before any resolution. Every code-registered fragment
 * lands on that tier, so the reference is preserved everywhere it is visible and honoured nowhere,
 * and the surface most confident about it is the one telling a human the body is live.
 *
 * An ERROR rather than a warning, because it is a dead seam rather than a degraded one: there is no
 * deployment state in which the reference starts resolving, and the failure it produces is a lie
 * rather than an omission.
 *
 * The refusal is deliberately NOT "honour it at builtin tier", which is what the report that
 * surfaced this asked for. `resolveDocumentBody` needs a connection WORKSPACE to fetch through, and
 * a deployment-wide registration has none: resolving through an arbitrary tenant's stored
 * credential would fetch text into every other workspace's prompts on one workspace's connection,
 * and would key ONE deployment-wide document under N per-workspace cache groups. That is the exact
 * fan-out the existing guard refuses for the account tier, and it is not an oversight. A living
 * deployment-wide document needs a DEPLOYMENT-scoped document source (an owner-scope change, a
 * credential home and a mothership routing decision), which is its own initiative rather than a
 * field on a registration.
 */
function checkPromptFragments(opts: ValidateRegistrationsOptions): RegistrationProblem[] {
  const registry = opts.registries.promptFragmentRegistry
  if (!registry) return []
  return registry
    .all()
    .filter((fragment) => fragment.documentRef)
    .map((fragment) => ({
      severity: 'error' as const,
      code: 'fragment_document_ref_unsupported',
      message:
        `Prompt fragment "${fragment.id}" is registered in code with a documentRef, which is ` +
        `carried through the catalog and rendered as a live source but is never resolved: a ` +
        `code-registered fragment lands on the "builtin" tier, and live resolution needs a ` +
        `connection workspace a deployment-wide registration cannot name. Register the body ` +
        `inline instead, or create the fragment at the ACCOUNT tier (POST the fragment with its ` +
        `documentRef and a fetch-via workspace), which is the supported path to an org-wide ` +
        `living document.`,
    }))
}

/**
 * Section 9 of {@link collectRegistrationProblems}: every generative binary integration a
 * deployment registers must be a definition the platform can actually dispatch against.
 *
 * Boot is the only place these can be caught. There is no write boundary that ever refused them
 * (they are code), and every failure below is silent at run time in the same expensive way: a
 * malformed definition or an unparseable contract becomes an integration the brief describes with
 * no operations, a credential key that is not a valid environment-variable name is dropped by the
 * harness's env validation and reappears as an unexplained 401 mid-run, and a cleartext endpoint
 * puts that credential on the wire from inside the run container. Each of those costs a run to
 * discover and names nothing that points back at the registration.
 *
 * A declared MEDIA TYPE that contradicts the declared modalities is an error too, not a warning:
 * both halves drive selection (a step's content-type coverage is checked against `modalities`,
 * while the brief tells the agent the `mediaTypes`), so an integration claiming `audio` while
 * listing `image/png` will be picked for one job and asked to do the other.
 */
function checkBinaryGenerators(opts: ValidateRegistrationsOptions): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  if (!opts.registries.binaryGeneratorRegistry) return problems
  for (const definition of opts.registries.binaryGeneratorRegistry.all()) {
    const issues = binaryGeneratorDefinitionIssues(definition)
    if (issues.length > 0) {
      problems.push({
        severity: 'error',
        code: 'binary_generator_invalid',
        message: `Generative binary integration "${definition.id}" is not a valid definition: ${issues.join('; ')}`,
      })
      // The checks below read fields this parse just called malformed, so reporting them too
      // would restate one fault as several.
      continue
    }
    problems.push(...checkBinaryGeneratorDetails(definition))
  }
  return problems
}

/** The per-definition checks a valid PARSE cannot make: the endpoint, contracts, media types. */
function checkBinaryGeneratorDetails(definition: BinaryGeneratorDefinition): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const invalid = (code: string, message: string): void => {
    problems.push({ severity: 'error', code, message })
  }
  // The same rule an HTTP tool server's URL is held to, and for the same reason the helper
  // states: a declared credential rides this request, so cleartext off loopback puts it on the
  // wire. (The helper is MCP-named because that was its first caller; the rule is not.)
  if (definition.endpoint && !isAllowedMcpHttpUrl(definition.endpoint)) {
    invalid(
      'insecure_binary_generator_endpoint',
      `Generative binary integration "${definition.id}" has endpoint "${definition.endpoint}". Its ` +
        `credential is sent with every request, so the endpoint must be https (plain http is ` +
        `accepted only on loopback).`,
    )
  }
  for (const problem of validateFoundationalDefinition({ contracts: definition.contracts })) {
    invalid(
      'binary_generator_invalid',
      `Generative binary integration "${definition.id}": ${describeFoundationalProblem(problem)}`,
    )
  }
  const declared = new Set(definition.modalities)
  for (const mediaType of definition.mediaTypes ?? []) {
    const consistent = modalitiesOfMediaType(mediaType)
    // An UNRECOGNISED media type is not a fault: the platform's classifier is not a registry of
    // every format that exists, and refusing one would make registering a new codec impossible.
    // A recognised one that CONTRADICTS the declaration is, because both drive selection.
    //
    // Contradiction is an empty INTERSECTION, not an absent member, and for 3D that is the whole
    // difference: a `.glb` is consistent with both `3d-model` and `3d-scene` because the container
    // does not record which it holds, so requiring every member would refuse a scene generator
    // for declaring the only format it can emit.
    if (consistent.length > 0 && !consistent.some((modality) => declared.has(modality))) {
      const names = consistent.join('/')
      invalid(
        'binary_generator_modality_mismatch',
        `Generative binary integration "${definition.id}" declares media type "${mediaType}" ` +
          `(${names}) but lists none of those among its modalities ` +
          `(${definition.modalities.join(', ')}). A step selecting it for ${names} would be ` +
          `refused, and one selecting it for the listed modalities would be told it can emit this.`,
      )
    }
  }
  return problems
}

/**
 * Section 8 of {@link collectRegistrationProblems}: every foundational service a deployment
 * registers in code must be a definition the platform would have accepted over its own write
 * boundary.
 *
 * Boot is the whole point of registering in code rather than provisioning over REST. A stored
 * row was refused at the moment someone wrote it; a code definition has no such moment, and its
 * failures are the quiet kind — an OpenAPI document that does not parse becomes a catalog entry
 * listing no operations while looking perfectly registered, and a capability tag that misses
 * `asset-storage` by an underscore surfaces hours later as a refused run. Validating the SAME
 * shape and the SAME rules the REST boundary applies (`createFoundationalServiceSchema` +
 * `validateFoundationalDefinition`) means a deployment cannot register something it could not
 * have uploaded.
 */
function checkFoundationalServices(opts: ValidateRegistrationsOptions): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  if (!opts.registries.foundationalServiceRegistry) return problems
  for (const definition of opts.registries.foundationalServiceRegistry.all()) {
    const issues = foundationalServiceDefinitionIssues(definition)
    if (issues.length > 0) {
      problems.push({
        severity: 'error',
        code: 'foundational_service_invalid',
        message: `Foundational service "${definition.id}" is not a valid definition: ${issues.join('; ')}`,
      })
      // The document checks below read fields this parse just called malformed, so reporting
      // them too would restate one fault as several.
      continue
    }
    for (const problem of validateFoundationalDefinition(definition)) {
      problems.push({
        severity: 'error',
        code: 'foundational_service_invalid',
        message: `Foundational service "${definition.id}": ${describeFoundationalProblem(problem)}`,
      })
    }
  }
  return problems
}

/**
 * Section 7 of {@link collectRegistrationProblems}: every registered agent-kind VARIANT must vary
 * a kind that exists and must change something.
 *
 * Both failures are invisible at run time, which is why boot is the place to be loud. A variant of
 * a kind nobody registers can never be selected by a step that passes pipeline validation, so it
 * is simply dead configuration — the deployment believes a variation is available and no pipeline
 * can use it. A variant that sets NEITHER prompt field is worse than dead: it validates, it is
 * selectable, and the step runs exactly as if it were never configured, so the only symptom is
 * that a deliberately varied step behaves like the stock one.
 *
 * The base-kind check needs the built-in catalog (`knownAgentKinds`) for the same reason the
 * pipeline-kind check does — the backend has no runtime catalog of built-in kinds, so without it
 * a variant of `coder` would false-positive. The empty-prompt check needs nothing and always runs.
 */
function checkAgentKindVariants(
  opts: ValidateRegistrationsOptions,
  registeredKindIds: ReadonlySet<string>,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  for (const variant of opts.registries.agentKindRegistry.variants()) {
    if (!variant.systemPrompt?.trim() && !variant.promptAddition?.trim()) {
      problems.push({
        severity: 'error',
        code: 'variant_changes_nothing',
        message:
          `Agent variant "${variant.id}" sets neither systemPrompt nor promptAddition, so a step ` +
          `selecting it runs exactly the shipped "${variant.baseKind}" prompt. Give it one, or ` +
          `drop the registration.`,
      })
    }
    // A kind whose prompt `IterativeReviewService` composes from (workspace, kind) with no step in
    // hand: the variant could be selected on the step and would never reach the model. Refused at
    // pipeline save too (`assertValidAgentVariants`), but a deployment that registers one should
    // hear it at BOOT rather than the first time somebody tries to use it.
    if (variant.baseKind in INLINE_ENGINE_SYSTEM_PROMPTS) {
      problems.push({
        severity: 'error',
        code: 'variant_inline_engine_kind',
        message:
          `Agent variant "${variant.id}" varies "${variant.baseKind}", which runs inline in the ` +
          `engine and composes its prompt without a step, so no step could ever apply the ` +
          `variant. Vary a dispatched kind, or edit that agent's prompt per workspace instead.`,
      })
    }
    if (registeredKindIds.has(variant.baseKind)) continue
    if (opts.knownAgentKinds && !opts.knownAgentKinds.has(variant.baseKind)) {
      problems.push({
        severity: 'error',
        code: 'variant_unknown_base_kind',
        message:
          `Agent variant "${variant.id}" varies agent kind "${variant.baseKind}", which is ` +
          `neither a known built-in nor a registered kind. No pipeline step can select it.`,
      })
    }
  }
  problems.push(...checkPipelineVariantSelections(opts))
  return problems
}

/**
 * A registered PIPELINE selecting a variant on one of its steps must select one that exists and
 * that varies THAT step's kind — the same rule `assertValidAgentVariants` applies at pipeline save
 * and run start, applied at BOOT for the pipelines a deployment ships in code, which reach neither
 * of those boundaries until somebody starts a run.
 *
 * "The same rule" is load-bearing: a DISABLED step never runs, so it imposes no requirement here
 * either. Refusing one at boot while the builder saves it happily would make a shape valid or
 * invalid depending on which door it came through.
 */
function checkPipelineVariantSelections(opts: ValidateRegistrationsOptions): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  for (const pipeline of opts.registries.pipelineRegistry?.registered() ?? []) {
    pipeline.stepOptions?.forEach((options, i) => {
      const variantId = options?.agentVariantId
      if (!variantId || pipeline.enabled?.[i] === false) return
      const variant = opts.registries.agentKindRegistry.variant(variantId)
      const problem = !variant
        ? 'which this deployment does not register'
        : variant.baseKind !== pipeline.agentKinds[i]
          ? `which varies "${variant.baseKind}", not this step's kind`
          : undefined
      if (!problem) return
      problems.push({
        severity: 'error',
        code: 'pipeline_variant_unresolved',
        message:
          `Pipeline "${pipeline.id}" step ${i} ("${pipeline.agentKinds[i]}") selects agent ` +
          `variant "${variantId}", ${problem}.`,
      })
    })
  }
  return problems
}

/**
 * Section 6 of {@link collectRegistrationProblems}: a kind's declared capabilities must be
 * REACHABLE and COHERENT. Every check here covers something that otherwise fails invisibly at run
 * time — the agent just quietly works without the playbook or the tool it was supposed to have,
 * which is why boot is the right place to be loud. Split per capability; see each helper.
 *
 * Enumerated through `kindsWithCapabilities()` rather than `all()`, so the checks reach capabilities
 * attached BY ASSIGNMENT to a kind that is not a registry entry. That is the recommended path and
 * the heavily-used one (`assignToolServers('coder', …)`, `ci-fixer`, `tester-api`, `merger`,
 * `conflict-resolver`), and walking `all()` skipped every one of them: a cleartext endpoint or a
 * reserved credential key declared that way booted clean, and only the dispatch-time floors caught
 * it, which is a floor holding rather than the "refused at declaration" layer doing its job.
 */
function checkAgentCapabilities(registry: AgentKindRegistry): RegistrationProblem[] {
  return registry
    .kindsWithCapabilities()
    .flatMap((kind) => [
      ...checkKindSkills(kind, registry),
      ...checkKindToolServers(kind, registry),
    ])
}

/**
 * A kind's declared SKILLS:
 *
 * - an id with no registration (a typo, or a `registerSkill` call that never ran) is an ERROR;
 * - skills on a NON-container kind is a WARNING, exactly as for tool servers below. Only the
 *   container executor renders `AgentRunContext.skills` into a dispatch, so an inline kind's
 *   declaration can never take effect — and a non-optional `{ catalogSkillId }` there is worse
 *   than inert, since it fails EVERY dispatch of that kind on a deployment with no skill library
 *   while never being able to reach the model.
 *
 * The container question goes through `runsInContainer`, never `registry.requiresContainer`, and
 * that is load-bearing now that assigned capabilities are checked: `requiresContainer` answers false
 * for a kind it has no registration for, so every built-in (`coder` above all) would be warned about
 * as an inline kind the moment a deployment assigned it a playbook.
 */
function checkKindSkills(kind: AgentKind, registry: AgentKindRegistry): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const skills = registry.skillsFor(kind)
  for (const id of skills.unknown) {
    problems.push({
      severity: 'error',
      code: 'unknown_bundled_skill',
      message:
        `Agent kind "${kind}" declares skill "${id}", which is not registered. Call ` +
        `registry.registerSkill({ id: '${id}', … }) before registering the kind, declare the ` +
        `skill inline, or use { catalogSkillId } for a repo-synced skill.`,
    })
  }
  const declared = skills.bundled.length + skills.catalog.length
  if (declared && !runsInContainer(kind, registry)) {
    problems.push({
      severity: 'warn',
      code: 'skills_without_container',
      message:
        `Agent kind "${kind}" declares skills but does not run in a container — only a container ` +
        `dispatch installs a skill and folds its instructions into the prompt, so an inline LLM ` +
        `step will never apply them. Give the kind a container surface (agent.surface: ` +
        `'container-explore' / 'container-coding') or drop the skills.`,
    })
  }
  return problems
}

/**
 * A kind's declared TOOL SERVERS: the whole-list checks (unregistered ids, the per-dispatch budget,
 * the container surface), with each definition's own checks in
 * {@link checkToolServerDefinition}. "Declared for" includes assigned servers, see
 * {@link checkAgentCapabilities}.
 *
 * - an unregistered id is an ERROR, like an unregistered skill;
 * - past EITHER dimension of the per-dispatch budget is a WARNING, because the dispatch drops the
 *   excess under `over_budget` rather than failing: the run still works, with fewer tools than the
 *   deployment believes it wired, and boot is the only place the DECLARATIONS past the line can be
 *   named. A warning also keeps the accretion case honest, a kind going over budget through
 *   `assignToolServers` calls in several packages none of which is individually wrong. Both
 *   dimensions are checked because the dispatch enforces both, and a byte-driven drop is the one
 *   that surprises: a handful of servers with fat `env`/`args`/`headers` blocks is under the count
 *   and over the payload;
 * - tool servers on a NON-container kind is a WARNING: an inline LLM call has no CLI to wire them
 *   into, so they can never take effect. A warning rather than an error because a deployment may
 *   deliberately declare them ahead of moving the kind onto a container surface.
 */
function checkKindToolServers(kind: AgentKind, registry: AgentKindRegistry): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const tools = registry.toolServersFor(kind)
  for (const id of tools.unknown) {
    problems.push({
      severity: 'error',
      code: 'unknown_tool_server',
      message:
        `Agent kind "${kind}" declares tool server "${id}", which is not registered. Call ` +
        `registry.registerToolServer({ id: '${id}', … }) before registering the kind, or ` +
        `declare the server inline.`,
    })
  }
  for (const server of tools.servers) problems.push(...checkToolServerDefinition(kind, server))
  problems.push(...checkToolServerBudget(kind, tools.servers))
  if (tools.servers.length && !runsInContainer(kind, registry)) {
    problems.push({
      severity: 'warn',
      code: 'tool_servers_without_container',
      message:
        `Agent kind "${kind}" declares tool servers but does not run in a container — an ` +
        `inline LLM step has no agent CLI to wire them into, so they will never be available. ` +
        `Give the kind a container surface (agent.surface: 'container-explore' / ` +
        `'container-coding') or drop the tool servers.`,
    })
  }
  return problems
}

/**
 * The per-dispatch budget, BOTH dimensions, as warnings: the dispatch drops the excess under
 * `over_budget` and the run works with fewer tools, so a registration fault belongs at boot rather
 * than in a refusal that takes the deployment down.
 *
 * The byte check measures {@link toolServerDeclaredBytes}, which is a FLOOR (a resolved credential
 * only adds to it), so a declaration already past the budget here is certainly past it at dispatch.
 * What boot deliberately does NOT claim is WHICH servers a run will lose: the dispatch keeps every
 * server that still fits, so once bytes are what bind the survivors are not a prefix of the
 * declaration. The count and the budget are what the author acts on, and the run itself names each
 * server it dropped.
 */
function checkToolServerBudget(
  kind: AgentKind,
  servers: readonly McpServerDefinition[],
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  if (servers.length > TOOL_SERVER_BUDGET.maxServers) {
    problems.push({
      severity: 'warn',
      code: 'too_many_tool_servers',
      message:
        `Agent kind "${kind}" has ${servers.length} tool servers declared for it, past the ` +
        `per-dispatch budget of ${TOOL_SERVER_BUDGET.maxServers}. A dispatch wires the first ` +
        `${TOOL_SERVER_BUDGET.maxServers} in declaration order and states the rest to the agent as ` +
        `unavailable (over_budget). Drop some, or split the work across kinds.`,
    })
  }
  const bytes = servers.reduce((total, server) => total + toolServerDeclaredBytes(server), 0)
  if (bytes > TOOL_SERVER_BUDGET.maxTotalBytes) {
    problems.push({
      severity: 'warn',
      code: 'tool_servers_over_byte_budget',
      message:
        `Agent kind "${kind}" declares tool servers whose transport config alone measures ${bytes} ` +
        `bytes, past the per-dispatch budget of ${TOOL_SERVER_BUDGET.maxTotalBytes}. A dispatch ` +
        `wires servers until that budget is spent and states the rest to the agent as unavailable ` +
        `(over_budget); resolved credentials only add to this figure, and which servers lose out ` +
        `depends on their sizes. Trim the env/args/headers blocks, or split the work across kinds.`,
    })
  }
  return problems
}

/**
 * ONE tool server definition:
 *
 * - a malformed MCP server id is an ERROR, because it becomes both a tool-name fragment and a
 *   Codex TOML table key, so the CLI fails on it far from the registration that caused it;
 * - an `allowedTools` entry that is not a valid tool NAME is an ERROR, the comma case above all:
 *   the harness joins the whole list into one `--allowedTools` argument with commas, so an entry
 *   carrying one splits into two patterns and the second matches nothing, while the prompt goes on
 *   advertising the name verbatim. That is the "told about a tool it cannot call" failure the
 *   unavailability vocabulary exists to prevent;
 * - a definition NO harness could ever serve is a WARNING, and it is the only check here a run
 *   structurally cannot report: an `http` server narrowed to `harnesses: ['codex']` (whose client
 *   is stdio-only), or anything narrowed to `['pi']` (which has no MCP client), is never dropped
 *   FOR A REASON on any run. It simply never applies, so no prompt and no log line ever mentions
 *   it. A warning rather than an error because the declaration is inert rather than dangerous;
 * - a cleartext `http://` endpoint off loopback is an ERROR: a resolved credential rides that
 *   request as a header, and the harness refuses the same URL at the job boundary — so allowing
 *   it here only moves the failure to a place with no registration to point at.
 */
function checkToolServerDefinition(
  kind: AgentKind,
  server: McpServerDefinition,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const on = `(on agent kind "${kind}")`
  if (!isValidMcpServerId(server.id)) {
    problems.push({
      severity: 'error',
      code: 'invalid_tool_server_id',
      message:
        `Tool server "${server.id}" ${on} has an invalid id. It becomes part of the tool names ` +
        `the CLI exposes (mcp__<id>__<tool>) and a Codex config key, so it must match ` +
        `[a-z0-9][a-z0-9_-]*.`,
    })
  }
  for (const tool of server.allowedTools ?? []) {
    if (isValidMcpToolName(tool)) continue
    problems.push({
      severity: 'error',
      code: 'invalid_tool_server_tool_name',
      message:
        `Tool server "${server.id}" ${on} restricts allowedTools to "${tool}", which is not a ` +
        `single tool name (letters, digits, "_", "." and "-"). The harness joins the list into ` +
        `one --allowedTools argument with commas, so an entry with a comma or whitespace becomes ` +
        `patterns that match nothing while the prompt still advertises the name. List each tool ` +
        `as its own entry.`,
    })
  }
  const servable = mcpServableHarnesses(server)
  if (servable.length === 0) {
    problems.push({
      severity: 'warn',
      code: 'tool_server_unservable',
      message:
        `Tool server "${server.id}" ${on} declares transport "${server.transport.kind}" for ` +
        `harnesses [${(server.harnesses ?? MCP_SUPPORTED_HARNESSES).join(', ')}], and no harness ` +
        `can serve that combination, so the server never applies to any run and no prompt or log ` +
        `line will say why. Codex's MCP client is stdio-only and Pi has none at all. Widen the ` +
        `harnesses, change the transport, or drop the declaration.`,
    })
  }
  if (server.transport.kind === 'http' && !isAllowedMcpHttpUrl(server.transport.url)) {
    problems.push({
      severity: 'error',
      code: 'insecure_tool_server_url',
      message:
        `Tool server "${server.id}" ${on} has url "${server.transport.url}". An HTTP tool server ` +
        `carries its resolved credential in a request header, so the url must be https (plain ` +
        `http is accepted only on loopback).`,
    })
  }
  for (const secret of server.secretKeys ?? []) {
    problems.push(...checkToolServerSecret(kind, server, secret))
  }
  problems.push(...checkToolServerOAuth(kind, server))
  return problems
}

/**
 * A tool server's OAUTH declaration, when it has one. Four rules, and each of them names a failure
 * that is otherwise invisible until a run or a button press:
 *
 * - `oauth` on a `stdio` server is an ERROR. A stdio server is a child process the CLI spawns;
 *   there is no request to authorise, so the declaration is inert and reads as configured. The
 *   dispatch drops the OAuth half silently for the mothership case, which is exactly why boot is
 *   where the fault has to be named.
 * - a declared endpoint that fails the URL floor is an ERROR, and this is the sharpest one here:
 *   an OAuth exchange carries the client secret and the tokens, so a cleartext endpoint puts both
 *   on the wire. A DISCOVERED endpoint is held to the same rule at the moment it is read.
 * - a reserved `clientSecretKey` is an ERROR for the reason every capability credential is: the
 *   declaration names both the key it wants and the token endpoint that key is posted to.
 * - a `secretKeys` entry naming the same header the access token rides is a WARNING. Both would
 *   land in one header map and the granted token wins, so the static credential silently does
 *   nothing — which reads, to whoever declared it, as the platform ignoring their credential.
 */
function checkToolServerOAuth(kind: AgentKind, server: McpServerDefinition): RegistrationProblem[] {
  const oauth = server.oauth
  if (!oauth) return []
  const problems: RegistrationProblem[] = []
  const on = `(on agent kind "${kind}")`
  if (server.transport.kind !== 'http') {
    problems.push({
      severity: 'error',
      code: 'oauth_requires_http_transport',
      message:
        `Tool server "${server.id}" ${on} declares OAuth on a "${server.transport.kind}" ` +
        `transport. OAuth authenticates a REQUEST, and a stdio server is a child process the ` +
        `agent CLI spawns with no request to authorise — pass its credential through secretKeys ` +
        `instead.`,
    })
  }
  for (const [field, url] of [
    ['authorizationUrl', oauth.authorizationUrl],
    ['tokenUrl', oauth.tokenUrl],
  ] as const) {
    if (url === undefined || isAllowedMcpHttpUrl(url)) continue
    problems.push({
      severity: 'error',
      code: 'insecure_oauth_endpoint',
      message:
        `Tool server "${server.id}" ${on} declares OAuth ${field} "${url}". The exchange carries ` +
        `the client secret and the access token, so the endpoint must be https (plain http is ` +
        `accepted only on loopback).`,
    })
  }
  if (oauth.clientSecretKey !== undefined && isReservedPlatformEnvKey(oauth.clientSecretKey)) {
    problems.push({
      severity: 'error',
      code: 'reserved_credential_key',
      message:
        `Tool server "${server.id}" ${on} declares OAuth client secret ` +
        reservedEnvKeyMessage(oauth.clientSecretKey),
    })
  }
  const tokenHeader = (oauth.header ?? MCP_OAUTH_DEFAULT_HEADER).toLowerCase()
  for (const secret of server.secretKeys ?? []) {
    if (secret.header?.toLowerCase() !== tokenHeader) continue
    problems.push({
      severity: 'warn',
      code: 'oauth_header_collision',
      message:
        `Tool server "${server.id}" ${on} declares credential "${secret.key}" on header ` +
        `"${secret.header}", which is also where its OAuth access token is sent. The granted ` +
        `token wins, so that credential reaches the server as nothing at all — send it under a ` +
        `different header, or drop it.`,
    })
  }
  return problems
}

/**
 * ONE credential a tool server declares. The reserved-key check is the sharpest rule in this file:
 * a definition names both the key it wants and the endpoint that key is sent to, so
 * `{ key: 'ENCRYPTION_KEY', header: 'Authorization' }` is a registration that boots clean and ships
 * the deployment's master sealing key to a third party. The generative-integration half of the same
 * rule is enforced by its credential SCHEMA (there is no schema here — a tool server is a TypeScript
 * registration), and dispatch refuses both again for the mothership case.
 */
function checkToolServerSecret(
  kind: AgentKind,
  server: McpServerDefinition,
  secret: McpSecretRef,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const on = `(on agent kind "${kind}")`
  if (isReservedPlatformEnvKey(secret.key)) {
    problems.push({
      severity: 'error',
      code: 'reserved_credential_key',
      message: `Tool server "${server.id}" ${on} declares credential ${reservedEnvKeyMessage(secret.key)}`,
    })
  }
  if (secret.envName === undefined) return problems
  // The injection name is NOT held to the reserved floor (it reads nothing), so it carries its own
  // rule: a value set as `PATH` or `npm_config_registry` reconfigures the server's process instead
  // of authenticating a call. Dispatch drops one too, for the mothership case.
  if (!isEnvVariableName(secret.envName)) {
    problems.push({
      severity: 'error',
      code: 'invalid_credential_env_name',
      message:
        `Tool server "${server.id}" ${on} declares credential envName "${secret.envName}", which ` +
        `is not a valid environment variable name. It becomes a variable of the server's process, ` +
        `and the harness drops anything else.`,
    })
  }
  if (isToolchainEnvName(secret.envName)) {
    problems.push({
      severity: 'error',
      code: 'toolchain_credential_env_name',
      message: `Tool server "${server.id}" ${on} declares credential ${toolchainEnvNameMessage(secret.envName)}`,
    })
  }
  // An `http` server sends its value as a HEADER, so an injection name would be read by nothing.
  // A warning rather than an error: the declaration still works, it just says something that cannot
  // take effect, and failing boot over it would be out of proportion.
  if (server.transport.kind === 'http' && secret.header) {
    problems.push({
      severity: 'warn',
      code: 'unused_credential_env_name',
      message:
        `Tool server "${server.id}" ${on} declares credential envName "${secret.envName}" on a ` +
        `key that names a header. An http server's value is sent as that header, so the injection ` +
        `name is never used.`,
    })
  }
  return problems
}

/**
 * Section 3 of {@link collectRegistrationProblems}: a coherence WARNING for a kind that declares
 * postOps but whose agent step is not structured output — those post-ops read `result.custom` and
 * would see nothing. Heuristic, hence a warning. Split out to keep the collector under the
 * complexity ceiling.
 */
function checkPostOpsStructuredOutput(
  agentKinds: ReturnType<AgentKindRegistry['all']>,
  registry: AgentKindRegistry,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  for (const def of agentKinds) {
    const hasPostOps = (def.postOps?.length ?? 0) > 0
    const declaresStructured =
      def.agent?.output?.kind === 'structured' || registry.structuredOutput(def.kind) !== undefined
    if (hasPostOps && def.agent && !declaresStructured) {
      problems.push({
        severity: 'warn',
        code: 'postops_without_structured_output',
        message:
          `Agent kind "${def.kind}" declares postOps but its agent step has no structured ` +
          `output — postOps that read result.custom will see nothing. Declare structuredOutput ` +
          `(or agent.output.kind: 'structured') if the post-op consumes the agent's JSON.`,
      })
    }
  }
  return problems
}

/**
 * Section 4 of {@link collectRegistrationProblems}: every kind a registered pipeline names must
 * resolve to a known built-in, a registered kind, a registered gate, or a built-in helper. Only
 * run when a built-in catalog (`knownAgentKinds`) is supplied. Split out to keep the collector
 * under the complexity ceiling.
 */
function checkPipelineKinds(
  opts: ValidateRegistrationsOptions,
  registeredKindIds: ReadonlySet<string>,
  gateKinds: ReadonlySet<string>,
  builtInHelperKinds: ReadonlySet<string>,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  if (!opts.knownAgentKinds) return problems
  const known = opts.knownAgentKinds
  for (const pipeline of opts.registries.pipelineRegistry?.registered() ?? []) {
    for (const agentKind of pipeline.agentKinds) {
      const ok =
        known.has(agentKind) ||
        registeredKindIds.has(agentKind) ||
        gateKinds.has(agentKind) ||
        builtInHelperKinds.has(agentKind)
      if (!ok) {
        problems.push({
          severity: 'error',
          code: 'pipeline_unknown_kind',
          message:
            `Pipeline "${pipeline.id}" references agent kind "${agentKind}", which is not a ` +
            `known built-in, a registered kind, or a registered gate.`,
        })
      }
    }
  }
  return problems
}

/**
 * Section 4b of {@link collectRegistrationProblems}: a registry RETIREMENT that names a pipeline the
 * live catalog still ships. `retiredPipelines()` keeps a live pipeline over a tombstone for it —
 * deliberately, or a deployment could empty the curated built-in palette one `retire()` call at a
 * time — so such a call does exactly nothing. That is the failure this check exists for: the
 * deployment believes it withdrew a pipeline, every workspace keeps offering it, and nothing
 * anywhere says why. An ERROR rather than a warning because there is no forward state in which the
 * call starts working (unlike `skills_without_container`, which a container surface would fix); it
 * is the same shape as a typo'd id, and boot is where the author can still act on it.
 *
 * Retiring an id that resolves to NOTHING is not a problem and must not be reported: a tombstone for
 * a pipeline an older version of the deployment's own package shipped is the intended use — the
 * definition is long gone from their code, and the whole point is to reach the boards that still
 * store the row.
 */
function checkPipelineRetirements(opts: ValidateRegistrationsOptions): RegistrationProblem[] {
  const registry = opts.registries.pipelineRegistry
  if (!registry) return []
  const retired = registry.retired()
  if (retired.length === 0) return []
  // Resolve the live catalog THROUGH the registry, so a deployment that both registers and retires
  // is judged on its own merged catalog rather than kernel's built-ins alone.
  const live = new Set(seedPipelines(registry).map((p) => p.id))
  return retired
    .filter((pipeline) => live.has(pipeline.id))
    .map((pipeline) => ({
      severity: 'error' as const,
      code: 'retirement_of_live_pipeline',
      message:
        `Pipeline "${pipeline.id}" is retired on the pipeline registry but the live catalog still ` +
        `ships it, so the retirement has no effect. A deployment can only withdraw its OWN ` +
        `registered pipelines; withdrawing a BUILT-IN means deleting its definition from kernel's ` +
        `seed builders and naming it in buildRetiredPipelines(). Drop the retire() call or remove ` +
        `the definition that keeps it live.`,
    }))
}

/**
 * A registered task type's `defaultFragmentIds` that the CODE pool cannot resolve, reported as a
 * WARN rather than an error, and the severity is the whole point. The pool visible at boot is the
 * injected registry (the shipped catalog plus the deployment's own `registerAll`); an account- or
 * workspace-tier
 * fragment row merges per WORKSPACE at run time, so boot structurally cannot see one and refusing
 * would reject a legitimate tenant-tier reference. The message therefore names both causes rather
 * than asserting the typo it cannot distinguish. Run-time behaviour is unchanged either way: an
 * id that resolves against nothing is skipped when bodies are composed.
 */
function checkTaskTypeFragments(
  taskType: CustomTaskType,
  pool: Set<string>,
  /** The ids to check; defaults to the type's unconditional `defaultFragmentIds`. */
  ids: readonly string[] = taskType.defaultFragmentIds ?? [],
  /** Which declaration the ids came from, so the message names the key the reader must go edit. */
  declaredBy: 'defaultFragmentIds' | 'conditionalFragmentIds' = 'defaultFragmentIds',
): RegistrationProblem[] {
  const unresolved = ids.filter((id) => !pool.has(id))
  if (unresolved.length === 0) return []
  return [
    {
      severity: 'warn',
      code: 'task_type_unknown_fragment',
      message:
        `Custom task type "${taskType.taskType}" declares ${declaredBy} ` +
        `${unresolved.map((id) => `"${id}"`).join(', ')}, which this deployment's registered ` +
        `fragment pool does not resolve. Either the id is a typo (a task of this type would then ` +
        `be seeded with a fragment that folds nothing), or it names an account/workspace-tier ` +
        `fragment, which merges per workspace at run time and is invisible here. Check the id ` +
        `against what the deployment passes to promptFragmentRegistry.registerAll().`,
    },
  ]
}

/**
 * The fragment ids boot can HONESTLY check a declaration against, or `undefined` when there is no
 * such pool in this process and the id checks must not run at all.
 *
 * Two ways that happens, and they are the same fact: no registry was supplied (an embedder or a
 * test constructing the checker directly), or the deployment resolves its pool REMOTELY, which is
 * every mothership-mode node. There the local registry holds the shipped catalog and nothing else,
 * because the deployment is told to register its standards on the mothership's entry point, so
 * judging `defaultFragmentIds` against it would warn about every org standard at every boot for a
 * configuration that resolves correctly at run time. Silence is right here rather than a warn of
 * its own: the operator already gets one line naming exactly this at the mothership boot path, and
 * a per-task-type repeat of it would bury the checks that CAN speak.
 */
function visibleFragmentPool(registries: ValidatedRegistries): Set<string> | undefined {
  if (!registries.promptFragmentRegistry) return undefined
  if (registries.promptFragments && !registries.promptFragments.inProcess) return undefined
  return new Set(registries.promptFragmentRegistry.all().map((fragment) => fragment.id))
}

/**
 * A registered task type's CONDITIONAL standing context: the entries whose fragment ids join
 * `defaultFragmentIds` when their condition holds against the values a creation collected.
 *
 * Two checks, at deliberately different severities:
 *
 * - a `when.key` naming a field the type does not DECLARE is an ERROR, the same class as
 *   `task_type_field_unknown_condition` on a field's own `showWhen` and for the same reason: every
 *   input is fully known from the registration, the condition can never hold, and the only symptom
 *   is guidance that silently never seeds. There is no forward state in which it starts working.
 * - an unresolvable fragment ID is the same WARN `defaultFragmentIds` gets, through the same
 *   checker, because the reason is identical: an account/workspace-tier id merges per workspace at
 *   run time and is structurally invisible at boot, so refusing here would reject the tenant-tier
 *   reference deployments are told to use.
 *
 * A rule whose condition names a field gated by its OWN `showWhen` is deliberately NOT reported.
 * It is coherent (the outer gate simply has to hold too) and it reduces to false when the value was
 * dropped by sanitisation, which is the behaviour documented on the contract.
 */
function checkConditionalFragments(
  taskType: CustomTaskType,
  pool: Set<string> | undefined,
): RegistrationProblem[] {
  const rules = taskType.conditionalFragmentIds ?? []
  if (rules.length === 0) return []
  const problems: RegistrationProblem[] = []
  for (const rule of rules) {
    if (!descriptorConditionHasPredicate(rule.when)) {
      // A `when` carrying neither `equals` nor `includes` is accepted by the schema (both are
      // optional, so a dropped `equals: 'graphql'` still validates) and reads as SATISFIED at run
      // time, because the shared evaluator defaults a predicate-less condition to `true`: right
      // for field visibility, where the alternative is hiding a field forever, and exactly wrong
      // here, where it seeds every case with guidance meant for one. Which is the silent
      // misseeding conditional fragments exist to remove, so it is an error rather than a warn.
      problems.push({
        severity: 'error',
        code: 'task_type_conditional_no_predicate',
        message:
          `Custom task type "${taskType.taskType}" gates conditional fragments ` +
          `${rule.fragmentIds.map((id) => `"${id}"`).join(', ')} on field "${rule.when.key}" ` +
          `with neither an "equals" nor an "includes" predicate, so the condition always holds ` +
          `and those fragments would be seeded onto EVERY task of this type. Give the condition ` +
          `a predicate, or move the ids to defaultFragmentIds if that is what you meant.`,
      })
    }
  }
  // A type with a bespoke `formPanel` collects its values through a component rather than a
  // descriptor form, so it legitimately declares no `fields` and there is nothing here to check a
  // `when.key` against. Skipping is not a hole: the panel is the deployment's own code, and the
  // alternative was refusing BOOT for the one shape the feature is built to support.
  const declared = new Set((taskType.fields ?? []).map((field) => field.key))
  if (taskType.formPanel === undefined || (taskType.fields?.length ?? 0) > 0) {
    for (const rule of rules) {
      if (!declared.has(rule.when.key)) {
        problems.push({
          severity: 'error',
          code: 'task_type_field_unknown_condition',
          message:
            `Custom task type "${taskType.taskType}" gates conditional fragments ` +
            `${rule.fragmentIds.map((id) => `"${id}"`).join(', ')} on field "${rule.when.key}", ` +
            `which it does not declare, so the condition can never hold and those fragments ` +
            `would never be seeded.`,
        })
      }
    }
  }
  if (!pool) return problems
  // Reported as ONE list rather than per rule: the unresolvable-id message names the cause it
  // cannot distinguish (typo vs tenant tier), and repeating that paragraph per rule would bury the
  // ids it exists to name.
  const conditionalIds = rules.flatMap((rule) => rule.fragmentIds)
  return [
    ...problems,
    ...checkTaskTypeFragments(taskType, pool, conditionalIds, 'conditionalFragmentIds'),
  ]
}

/**
 * The surfaces that declare a descriptor-driven form, as the prefix their boot-error codes carry.
 *
 * A UNION rather than a `string`, so adding the next such surface has to come here and be named,
 * which is the moment to ask whether {@link descriptorFormProblems} is wired for it at all. That
 * question went unasked for the gate config form, which rendered through the same component for a
 * release with none of these checks behind it.
 */
type DescriptorFormSubject = 'task_type' | 'initiative_preset' | 'gate'

/**
 * A descriptor-driven FORM that structurally cannot be filled, plus the one grouping fault that has
 * no honest rendering. Each of these is a typo in the deployment's own descriptor with no run-time
 * recovery, and each fails SILENTLY without this check: a duplicate key means the later declaration
 * wins wherever the fields are indexed, an optionless picker renders an empty control (and, if
 * required, makes the subject un-creatable), and a `showWhen` naming no declared field hides its own
 * field forever, so the value can never be collected.
 *
 * Errors rather than warnings, because unlike a `defaultFragmentIds` id (which may legitimately name
 * a tenant-tier fragment invisible at boot) every input here is fully known from the registration.
 *
 * Takes a plain FIELD LIST, because every surface that declares a form draws on one vocabulary
 * (`contracts/src/form-fields.ts`) and renders through one component: a custom task type's per-case
 * form, an initiative preset's create form and a registered gate's per-step config form fail these
 * ways identically, so they are checked by one function under their own {@link DescriptorFormSubject}
 * prefixes rather than by a copy each. A surface reaching that component without reaching this
 * checker is the gap to look for.
 */
function descriptorFormProblems(
  fields: readonly DescriptorField[],
  codePrefix: DescriptorFormSubject,
  subject: string,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const seen = new Set<string>()
  const declared = new Set(fields.map((field) => field.key))
  const bad = (code: string, message: string): void => {
    problems.push({
      severity: 'error',
      code: `${codePrefix}_${code}`,
      message: `${subject} ${message}`,
    })
  }
  for (const field of fields) {
    if (seen.has(field.key)) bad('field_duplicate', `declares field "${field.key}" twice.`)
    seen.add(field.key)
    if ((field.type === 'select' || field.type === 'checkbox-group') && !field.options?.length) {
      bad(
        'field_no_options',
        `declares "${field.key}" as a ${field.type} with no options, so the form renders an empty picker.`,
      )
    }
    if (field.showWhen && !declared.has(field.showWhen.key)) {
      bad(
        'field_unknown_condition',
        `gates field "${field.key}" on "${field.showWhen.key}", which it does not declare, so the field never shows.`,
      )
    }
    problems.push(...defaultOutsideOptions(field, codePrefix, subject))
  }
  // A `section` a filled form can be made to caption TWICE. Presentation rather than fillability,
  // and an error all the same: the renderer preserves declaration order, so the caption renders
  // twice (reading as a platform fault rather than as the declaration it is), and the only
  // alternative would be moving a field away from where its author wrote it. Fully knowable from the
  // registration, so boot is where it can still be fixed.
  //
  // Reachability, not contiguity: interleaving a section with a MUTUALLY EXCLUSIVE branch is how a
  // form keeps each branch's fields beside the picker they qualify, and it prints one caption in
  // every state. Refusing it would fail boot over a form nobody can break.
  for (const caption of duplicatedDescriptorSectionCaptions(fields)) {
    bad(
      'field_section_interleaved',
      `declares section "${caption}" in two places with a field between them that shows at the ` +
        `same time, so its caption renders twice. Declare a section's fields consecutively ` +
        `(matching on case and spacing, which the renderer folds), or gate the field between them ` +
        `so it cannot show alongside both.`,
    )
  }
  return problems
}

/**
 * A declared DEFAULT that is not one of the field's own options: an error for the same reason the
 * three above are: fully known from the registration, and silently broken at run time.
 *
 * It became reachable when the creation door started folding defaults in
 * (`withDescriptorFieldDefaults`), which is what makes a default mean the same thing to a form and
 * to a headless caller. The consequence is that a default outside the picklist is no longer merely
 * a form that opens on an odd value: it is an answer the validator refuses, so EVERY creation of
 * the subject fails with "has a value outside its options" naming a value the caller never sent.
 */
function defaultOutsideOptions(
  field: DescriptorField,
  codePrefix: DescriptorFormSubject,
  subject: string,
): RegistrationProblem[] {
  const options = new Set((field.options ?? []).map((option) => option.value))
  if (options.size === 0) return []
  const declared =
    field.type === 'checkbox-group'
      ? (field.defaultValues ?? [])
      : field.type === 'select' && field.default !== undefined
        ? [field.default]
        : []
  return declared
    .filter((value) => !options.has(value))
    .map((value) => ({
      severity: 'error' as const,
      code: `${codePrefix}_field_default_outside_options`,
      message:
        `${subject} defaults field "${field.key}" to "${value}", which is not one of its ` +
        `options, so every creation of it is refused for a value the caller never sent.`,
    }))
}

/**
 * Section 5b of {@link collectRegistrationProblems}: every registered initiative PRESET's create
 * form must be fillable, on the same bar and through the same checker as a custom task type's (see
 * {@link descriptorFormProblems}). Only run when a preset registry is supplied.
 *
 * The built-in presets ride along rather than being exempted: they are registrations like any
 * other, and a shipped descriptor that broke its own form should fail this deployment's boot
 * exactly as a deployment-authored one does.
 */
function checkInitiativePresetForms(opts: ValidateRegistrationsOptions): RegistrationProblem[] {
  if (!opts.registries.initiativePresetRegistry) return []
  return opts.registries.initiativePresetRegistry
    .descriptors()
    .flatMap((descriptor) =>
      descriptorFormProblems(
        descriptor.fields,
        'initiative_preset',
        `Initiative preset "${descriptor.id}"`,
      ),
    )
}

/**
 * Section 5c of {@link collectRegistrationProblems}: every registered GATE's per-step config form
 * must be fillable and renderable, on the same bar and through the same checker as the two other
 * surfaces that declare a form ({@link descriptorFormProblems}).
 *
 * It is the third such surface and the one easiest to forget, because a gate declares its form as
 * an OPTION on `GateRegistry.register` rather than as a field of a descriptor type, so nothing about
 * the registration call says "this is a descriptor form". It renders through the very same
 * `DescriptorFields` component the other two do, which is exactly why it fails the same ways: a gate
 * that declared a duplicate key, an optionless picker, a `showWhen` naming nothing, a default
 * outside its options, or a section its form captions twice would boot clean and break where a
 * pipeline author authors, with nothing naming the registration that did it.
 *
 * Reads `configForms()`, so a gate declaring no fields is not a subject here rather than a subject
 * with an empty form.
 */
function checkGateConfigForms(opts: ValidateRegistrationsOptions): RegistrationProblem[] {
  return opts.registries.gateRegistry
    .configForms()
    .flatMap(({ kind, fields }) => descriptorFormProblems(fields, 'gate', `Gate "${kind}"`))
}

/**
 * Section 5 of {@link collectRegistrationProblems}: each custom task type must carry a NAMESPACED
 * id (`<ns>:<name>`) and, if set, a well-formed namespaced `formPanel` id; a `defaultPipelineId`
 * must resolve against the built-in + registered pipeline catalog (else the created task would
 * silently fall back to the positional default); its `defaultFragmentIds` are checked against the
 * code fragment pool (see {@link checkTaskTypeFragments}); and its create form must be fillable (see
 * {@link descriptorFormProblems}). Only run when a task-type registry is supplied. Split out to keep
 * the collector under the complexity ceiling.
 */
function checkCustomTaskTypes(opts: ValidateRegistrationsOptions): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  if (!opts.registries.taskTypeRegistry) return problems
  const knownPipelineIds = new Set(seedPipelines(opts.registries.pipelineRegistry).map((p) => p.id))
  const fragmentPool = visibleFragmentPool(opts.registries)
  for (const taskType of opts.registries.taskTypeRegistry.all()) {
    if (fragmentPool) problems.push(...checkTaskTypeFragments(taskType, fragmentPool))
    problems.push(
      ...descriptorFormProblems(
        taskType.fields ?? [],
        'task_type',
        `Custom task type "${taskType.taskType}"`,
      ),
    )
    problems.push(...checkConditionalFragments(taskType, fragmentPool))
    if (!isNamespacedId(taskType.taskType)) {
      problems.push({
        severity: 'error',
        code: 'task_type_not_namespaced',
        message:
          `Custom task type "${taskType.taskType}" is not a namespaced id (<ns>:<name>, ` +
          `lowercase a-z0-9, dash-separated). A bare id collides with the built-in picklist.`,
      })
    }
    if (taskType.formPanel !== undefined && !isNamespacedId(taskType.formPanel)) {
      problems.push({
        severity: 'error',
        code: 'task_type_form_panel_invalid',
        message:
          `Custom task type "${taskType.taskType}" declares formPanel "${taskType.formPanel}", ` +
          `which is not a namespaced id (<ns>:<name>). Pair it with a frontend component in the ` +
          `taskTypeFormPanels slot under that id.`,
      })
    }
    if (
      taskType.defaultPipelineId !== undefined &&
      !knownPipelineIds.has(taskType.defaultPipelineId)
    ) {
      problems.push({
        severity: 'error',
        code: 'task_type_unknown_pipeline',
        message:
          `Custom task type "${taskType.taskType}" declares defaultPipelineId ` +
          `"${taskType.defaultPipelineId}", which is neither a built-in nor a registered ` +
          `pipeline. Register the pipeline (PipelineRegistry) or fix the id.`,
      })
    }
  }
  return problems
}

/**
 * Validate the registered extensions, throwing an aggregated error on any `error`-severity
 * problem and logging `warn`-severity ones. Call once at facade boot, after every `register*`
 * import side effect + provider wiring, before serving requests.
 *
 * A deployment may raise selected warnings to errors with
 * {@link ValidateRegistrationsOptions.escalateWarning}; an escalated problem is thrown with the
 * errors and is NOT also logged, so one problem produces one report.
 */
export function validateRegistrations(opts: ValidateRegistrationsOptions): void {
  const problems = collectRegistrationProblems(opts)
  const escalate = opts.escalateWarning
  // Partition in ONE pass, before either half acts, so an escalated warn is reported exactly once
  // and lands in the same aggregated failure as the genuine errors rather than a second one after
  // them. The predicate is called once per warning for the same reason: it is deployment code, and
  // calling it twice would make an impure one disagree with itself between the log and the throw.
  const errors: RegistrationProblem[] = []
  const warnings: RegistrationProblem[] = []
  for (const problem of problems) {
    if (problem.severity === 'error') errors.push(problem)
    else if (escalate?.(problem)) errors.push(problem)
    else warnings.push(problem)
  }
  if (opts.onWarn) {
    for (const warning of warnings) opts.onWarn(warning)
  }
  if (errors.length > 0) {
    throw new Error(
      `Invalid extension registrations (${errors.length}):\n` +
        errors.map((e) => `  - [${e.code}] ${e.message}`).join('\n'),
    )
  }
}

// A module-level guard so a per-request facade build (the Worker rebuilds its container per
// request) validates ONCE rather than on every request. Tests that intentionally register
// bogus kinds call `collectRegistrationProblems`/`validateRegistrations` directly instead.
let validated = false

/** Run {@link validateRegistrations} at most once per process. Safe to call from a per-request build. */
export function validateRegistrationsOnce(opts: ValidateRegistrationsOptions): void {
  if (validated) return
  // Flip the guard only AFTER a clean validation. Setting it first would poison the guard on a
  // throw: on the Worker (where this runs inside `fetch` on the first request) a misconfigured
  // deployment would 500 exactly once, then — the module flag now `true` for the isolate's life —
  // serve the broken config silently on every later request. Validating until it passes keeps the
  // failure loud (every request re-throws) until the deployment is fixed, matching the boot intent.
  validateRegistrations(opts)
  validated = true
}

/** Reset the once-guard. Intended for tests that exercise the boot path repeatedly. */
export function resetRegistrationValidationGuard(): void {
  validated = false
}
