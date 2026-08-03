import type { AgentKindRegistry } from '@cat-factory/agents'
import { INLINE_ENGINE_SYSTEM_PROMPTS } from '@cat-factory/agents'
import type {
  AgentKind,
  BinaryGeneratorRegistry,
  FoundationalServiceRegistry,
  GateRegistry,
  PipelineRegistry,
  TaskTypeRegistry,
} from '@cat-factory/kernel'
import {
  CI_FIXER_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  FIXER_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  describeFoundationalProblem,
  isAllowedMcpHttpUrl,
  isValidMcpServerId,
  seedPipelines,
  stubGateContext,
  validateFoundationalDefinition,
} from '@cat-factory/kernel'
import {
  type BinaryGeneratorDefinition,
  binaryGeneratorDefinitionIssues,
  foundationalServiceDefinitionIssues,
  isNamespacedId,
  modalityOfMediaType,
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

/** Options for {@link collectRegistrationProblems} / {@link validateRegistrations}. */
export interface ValidateRegistrationsOptions {
  /**
   * The app-owned agent-kind registry to validate (the facade's injected instance). Required:
   * without it there are no registered kinds to cross-check the gates/pipelines against.
   */
  agentKindRegistry: AgentKindRegistry
  /**
   * The app-owned gate registry to validate (the facade's injected instance — the SAME one it
   * threads through `CoreDependencies.gateRegistry`). Required: the gate-helper + pipeline-kind
   * cross-checks read the registered gates from it rather than a module global.
   */
  gateRegistry: GateRegistry
  /**
   * The app-owned pipeline registry to validate (the facade's injected instance — the SAME one it
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
  const registry = opts.agentKindRegistry
  const problems: RegistrationProblem[] = []

  const agentKinds = registry.all()
  const registeredKindIds = new Set(agentKinds.map((d) => d.kind))
  const gateFactories = opts.gateRegistry.factories()
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

  // 6. Agent capabilities: the skills + tool servers each kind declares.
  problems.push(...checkAgentCapabilities(agentKinds, registry))

  // 7. Agent-kind VARIANTS: their base kind must exist and they must actually change the prompt.
  problems.push(...checkAgentKindVariants(opts, registeredKindIds))

  // 8. Deployment-registered FOUNDATIONAL SERVICES (only when a registry is supplied).
  problems.push(...checkFoundationalServices(opts))

  // 9. Deployment-registered GENERATIVE BINARY INTEGRATIONS (only when a registry is supplied).
  problems.push(...checkBinaryGenerators(opts))

  return problems
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
  if (!opts.binaryGeneratorRegistry) return problems
  for (const definition of opts.binaryGeneratorRegistry.all()) {
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
    const modality = modalityOfMediaType(mediaType)
    // An UNRECOGNISED media type is not a fault: the platform's classifier is not a registry of
    // every format that exists, and refusing one would make registering a new codec impossible.
    // A recognised one that contradicts the declaration is, because both drive selection.
    if (modality && !declared.has(modality)) {
      invalid(
        'binary_generator_modality_mismatch',
        `Generative binary integration "${definition.id}" declares media type "${mediaType}" ` +
          `(${modality}) but does not list "${modality}" among its modalities ` +
          `(${definition.modalities.join(', ')}). A step selecting it for ${modality} would be ` +
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
  if (!opts.foundationalServiceRegistry) return problems
  for (const definition of opts.foundationalServiceRegistry.all()) {
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
  for (const variant of opts.agentKindRegistry.variants()) {
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
  for (const pipeline of opts.pipelineRegistry?.registered() ?? []) {
    pipeline.stepOptions?.forEach((options, i) => {
      const variantId = options?.agentVariantId
      if (!variantId || pipeline.enabled?.[i] === false) return
      const variant = opts.agentKindRegistry.variant(variantId)
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
 */
function checkAgentCapabilities(
  agentKinds: ReturnType<AgentKindRegistry['all']>,
  registry: AgentKindRegistry,
): RegistrationProblem[] {
  return agentKinds.flatMap((def) => [
    ...checkKindSkills(def.kind, registry),
    ...checkKindToolServers(def.kind, registry),
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
  if (declared && !registry.requiresContainer(kind)) {
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
 * A kind's declared TOOL SERVERS:
 *
 * - an unregistered id is an ERROR, like an unregistered skill;
 * - a malformed MCP server id is an ERROR, because it becomes both a tool-name fragment and a
 *   Codex TOML table key, so the CLI fails on it far from the registration that caused it;
 * - a cleartext `http://` endpoint off loopback is an ERROR: a resolved credential rides that
 *   request as a header, and the harness refuses the same URL at the job boundary — so allowing
 *   it here only moves the failure to a place with no registration to point at;
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
  for (const server of tools.servers) {
    if (!isValidMcpServerId(server.id)) {
      problems.push({
        severity: 'error',
        code: 'invalid_tool_server_id',
        message:
          `Tool server "${server.id}" (on agent kind "${kind}") has an invalid id. It ` +
          `becomes part of the tool names the CLI exposes (mcp__<id>__<tool>) and a Codex ` +
          `config key, so it must match [a-z0-9][a-z0-9_-]*.`,
      })
    }
    if (server.transport.kind === 'http' && !isAllowedMcpHttpUrl(server.transport.url)) {
      problems.push({
        severity: 'error',
        code: 'insecure_tool_server_url',
        message:
          `Tool server "${server.id}" (on agent kind "${kind}") has url ` +
          `"${server.transport.url}". An HTTP tool server carries its resolved credential in a ` +
          `request header, so the url must be https (plain http is accepted only on loopback).`,
      })
    }
  }
  if (tools.servers.length && !registry.requiresContainer(kind)) {
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
  for (const pipeline of opts.pipelineRegistry?.registered() ?? []) {
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
  const registry = opts.pipelineRegistry
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
 * Section 5 of {@link collectRegistrationProblems}: each custom task type must carry a NAMESPACED
 * id (`<ns>:<name>`) and, if set, a well-formed namespaced `formPanel` id; a `defaultPipelineId`
 * must resolve against the built-in + registered pipeline catalog (else the created task would
 * silently fall back to the positional default). Only run when a task-type registry is supplied.
 * Split out to keep the collector under the complexity ceiling.
 */
function checkCustomTaskTypes(opts: ValidateRegistrationsOptions): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  if (!opts.taskTypeRegistry) return problems
  const knownPipelineIds = new Set(seedPipelines(opts.pipelineRegistry).map((p) => p.id))
  for (const taskType of opts.taskTypeRegistry.all()) {
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
 */
export function validateRegistrations(opts: ValidateRegistrationsOptions): void {
  const problems = collectRegistrationProblems(opts)
  if (opts.onWarn) {
    for (const w of problems.filter((p) => p.severity === 'warn')) opts.onWarn(w)
  }
  const errors = problems.filter((p) => p.severity === 'error')
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
