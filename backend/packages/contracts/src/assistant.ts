import * as v from 'valibot'
import { taskSourceKindSchema } from './tasks.js'

// ---------------------------------------------------------------------------
// THE IN-APP ASSISTANT: one natural-language prompt in, one PERFORMED ACTION out.
//
// The shape of the surface is the design decision worth stating here, because everything below
// follows from it: the model does not act. It reads the prompt and NAMES one action from a closed
// catalog plus the arguments it read out of the sentence; the platform then resolves those
// arguments against real board entities and performs the action through the same services the
// board's own buttons call. Nothing the model writes reaches a side effect, a stored row, or the
// screen as prose.
//
// That is why a turn answers with DATA rather than a chat message. Three outcomes, and the two
// that are not a completed action are as structured as the one that is:
//
//   performed:   the action ran. The result carries the ids and names of what it touched, so the
//                 SPA can link straight to the frame or task the turn produced.
//   needs_input: the platform could not resolve one argument to a board entity (no service by
//                 that name, two that match, a repository this workspace has not connected). It
//                 names the FIELD, the CANDIDATES it was choosing between where it has them, and
//                 the ARGUMENTS it resolved, which together are everything the next turn needs to
//                 ANSWER it without a model and without the sentence being retyped.
//   declined:    no action in the catalog matches what was asked for.
//
// A refusal that belongs to the deployment rather than to the sentence (no model wired, the
// budget spent, GitHub unconfigured, an issue already filed as a task) is NOT an outcome here: it
// is the `DomainError` the underlying service already raises, so it reaches the SPA through the
// one error funnel with its `details.reason` intact, exactly as the equivalent button does.
//
// Every string a user reads about a turn is rendered by the SPA from these machine-readable
// members, per the platform's "the backend does not localize prose" rule, which is also why no
// model-authored sentence is on the wire.
//
// See backend/docs/in-app-assistant.md.
// ---------------------------------------------------------------------------

/**
 * The actions the assistant can perform. CLOSED, and deliberately small.
 *
 * Each member is an operation the board already offers behind a form, so the assistant adds a
 * way to ASK for it rather than a capability nobody could otherwise reach. Adding a member means
 * adding its result variant below and its executor in the engine catalog, both of which fail to
 * compile until they exist.
 */
export const assistantActionIdSchema = v.picklist([
  /** Declare that one service depends on another, so both are spun up when the consumer is tested. */
  'declare-service-dependency',
  /** Add a service frame backed by an existing GitHub or GitLab repository, named by its web URL. */
  'add-service-from-repo',
  /** File a board task from a tracker issue (a GitHub/GitLab issue URL, or a Jira/Linear ticket). */
  'create-task-from-issue',
])
export type AssistantActionId = v.InferOutput<typeof assistantActionIdSchema>

/** Every action the assistant knows, in the order the SPA lists them as suggestions. */
export const ASSISTANT_ACTION_IDS = [
  'declare-service-dependency',
  'add-service-from-repo',
  'create-task-from-issue',
] as const satisfies readonly AssistantActionId[]

/** A board service the turn touched: enough to name it and to link to it. */
export const assistantServiceRefSchema = v.object({
  /** The service FRAME's block id. */
  blockId: v.string(),
  /** The frame's title, as it stands after the turn. */
  title: v.string(),
})
export type AssistantServiceRef = v.InferOutput<typeof assistantServiceRefSchema>

// ---- What each performed action reports ------------------------------------

/**
 * A declared dependency edge.
 *
 * `created` is false when the edge was already on the board. The turn still SUCCEEDED (the board
 * is in the state that was asked for), and saying so is what stops the SPA from reporting an
 * idempotent re-declaration as a fresh one.
 */
export const assistantDependencyDeclaredSchema = v.object({
  actionId: v.literal('declare-service-dependency'),
  /** The service that DEPENDS on the other (the edge is stored on this one). */
  consumer: assistantServiceRefSchema,
  /** The service depended ON, spun up alongside the consumer when it is tested. */
  provider: assistantServiceRefSchema,
  /** Whether this turn added the edge (false ⇒ it was already declared). */
  created: v.boolean(),
})

/**
 * A service frame backed by a repository.
 *
 * `created` distinguishes a new frame from an existing account service this board now MOUNTS,
 * the deduplication `addServiceFromRepo` performs for a whole-repo service the org already runs.
 * The two are different facts about the board, and a caller told only "here is your service"
 * would read the second as the first.
 */
export const assistantServiceAddedSchema = v.object({
  actionId: v.literal('add-service-from-repo'),
  service: assistantServiceRefSchema,
  /** The repository the frame is backed by. */
  repo: v.object({
    owner: v.string(),
    name: v.string(),
    /** The monorepo subdirectory the service lives in, or null for a whole-repo service. */
    directory: v.nullable(v.string()),
  }),
  /** Whether this turn created the frame (false ⇒ an existing org service was mounted here). */
  created: v.boolean(),
})

/** A board task filed from a tracker issue. */
export const assistantTaskCreatedSchema = v.object({
  actionId: v.literal('create-task-from-issue'),
  task: v.object({ blockId: v.string(), title: v.string() }),
  /** The service frame the task was filed under. */
  service: assistantServiceRefSchema,
  issue: v.object({
    source: taskSourceKindSchema,
    /** The source's canonical key (`owner/repo#12`, `PROJ-7`). */
    externalId: v.string(),
    url: v.string(),
  }),
})

/** What a performed turn did, discriminated by the action that did it. */
export const assistantActionResultSchema = v.variant('actionId', [
  assistantDependencyDeclaredSchema,
  assistantServiceAddedSchema,
  assistantTaskCreatedSchema,
])
export type AssistantActionResult = v.InferOutput<typeof assistantActionResultSchema>

// ---- What a turn that could NOT act reports --------------------------------

/**
 * Why the platform could not resolve one argument to something on the board.
 *
 * Each member names a DIFFERENT next move for the person, which is why they are not one
 * "could not resolve" value: an unknown name is retyped, an ambiguous one is picked from the
 * candidates, a missing argument is supplied, and an unconnected repository or tracker is a trip
 * to the integrations panel before the same sentence works.
 */
export const assistantClarificationReasonSchema = v.picklist([
  /** The prompt never named the argument, and it has no default. */
  'missing_argument',
  /** The argument was named, but the value is not one the platform can use (an unsafe path, an over-long name). */
  'invalid_argument',
  /** No board service matches the name that was given. */
  'unknown_service',
  /** Several board services match the name that was given; `candidates` holds them. */
  'ambiguous_service',
  /** The repository URL is well-formed, but this workspace has not connected that repository. */
  'unknown_repository',
  /** The URL does not parse as a repository the platform can read. */
  'unreadable_repository_url',
  /** No connected tracker recognises the issue URL. */
  'unknown_issue_source',
  /** Two connected trackers both recognise the issue URL, so which one is meant is unstated. */
  'ambiguous_issue_source',
  /** The issue's repository backs no service on this board, and the prompt named none. */
  'unresolved_issue_service',
])
export type AssistantClarificationReason = v.InferOutput<typeof assistantClarificationReasonSchema>

/**
 * One action's arguments on the wire: declared keys, string values.
 *
 * Capped per value at the same length as a prompt, because they come back INTO the platform when a
 * clarification is answered, and an unbounded value there would be a bigger input than the sentence
 * that produced it.
 */
export const assistantArgumentsSchema = v.record(v.string(), v.pipe(v.string(), v.maxLength(2000)))
export type AssistantArguments = v.InferOutput<typeof assistantArgumentsSchema>

/** Why no action ran at all. */
export const assistantDeclineReasonSchema = v.picklist([
  /** The prompt does not ask for anything in the catalog. */
  'no_matching_action',
])
export type AssistantDeclineReason = v.InferOutput<typeof assistantDeclineReasonSchema>

/**
 * The outcome of one turn.
 *
 * `needs_input` carries the action it was HEADING for, so the SPA can say what it was about to do
 * rather than only what it could not find, and `candidates` is the shortlist the platform was
 * choosing between (empty when there was nothing to choose from, since an unknown name has no
 * near-misses to offer).
 */
export const assistantOutcomeSchema = v.variant('status', [
  v.object({ status: v.literal('performed'), result: assistantActionResultSchema }),
  v.object({
    status: v.literal('needs_input'),
    actionId: assistantActionIdSchema,
    reason: assistantClarificationReasonSchema,
    /** The argument key that could not be resolved (`consumer`, `repoUrl`, `source`, …). */
    field: v.string(),
    /**
     * What the platform was choosing between, at most a handful. Empty ⇒ nothing matched.
     *
     * Every entry is a legal VALUE for {@link field}, not a label describing one, because the
     * clarification is answered by putting a candidate in that field (see
     * {@link assistantAnswerSchema}). An action offering a candidate its own next turn would
     * refuse is a question with no acceptable answer, which is why the near-misses an unknown
     * repository reports are `owner/name` slugs and the trackers an ambiguous reference reports
     * are source ids.
     */
    candidates: v.array(v.string()),
    /**
     * The arguments the turn resolved, so the answer can be a RESUMPTION rather than a retyped
     * sentence. Declared keys only, already validated, and the person's own words either way.
     */
    arguments: assistantArgumentsSchema,
  }),
  v.object({ status: v.literal('declined'), reason: assistantDeclineReasonSchema }),
])
export type AssistantOutcome = v.InferOutput<typeof assistantOutcomeSchema>

/** One turn: what the platform did, and which model read the prompt to decide it. */
export const assistantTurnSchema = v.object({
  outcome: assistantOutcomeSchema,
  /**
   * The model that chose the action, so a turn can be traced to the route that produced it.
   *
   * NULL for an ANSWERED clarification, which runs no model at all. Reporting the model the
   * previous turn used would attribute a deterministic re-run to a call that never happened, and
   * an absent value is the only honest way to say a turn spent nothing.
   */
  model: v.nullable(v.object({ provider: v.string(), model: v.string() })),
})
export type AssistantTurn = v.InferOutput<typeof assistantTurnSchema>

/**
 * Answering a question a previous turn asked, as DATA rather than as more prose.
 *
 * This is what makes a clarification terminate. The alternative the surface started with was to
 * append the chosen candidate to the sentence and route it through the model again, and that
 * cannot converge: the original words are still in the prompt (a repository under the wrong owner
 * stays there beside the right one), and a candidate the model has no declared argument to put it
 * in is simply dropped. Re-running the same action with the same arguments and the one field
 * replaced is exact, terminates in one step, and bills nothing.
 *
 * It grants no authority the prompt path does not. The arguments are re-validated by the same
 * descriptor rules, undeclared keys are dropped exactly as they are for a model's reply, every
 * name is re-resolved against the board, and the action is the same one a button performs under
 * the caller's own tier.
 */
export const assistantAnswerSchema = v.object({
  /** The action the question was asked on behalf of, as its outcome named it. */
  actionId: assistantActionIdSchema,
  /** That turn's arguments, with the answered field replaced by the value the person chose. */
  arguments: assistantArgumentsSchema,
})
export type AssistantAnswer = v.InferOutput<typeof assistantAnswerSchema>

/**
 * What a turn runs on: a sentence to route, or the answer to the question the last one asked.
 *
 * Discriminated rather than "a prompt plus an optional answer", because the two share no field: an
 * answered turn has no sentence to read and never reaches a model, and a shape carrying a required
 * prompt beside it would make every answer invent one.
 */
export const assistantTurnInputSchema = v.variant('kind', [
  v.object({
    kind: v.literal('prompt'),
    prompt: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  }),
  v.object({ kind: v.literal('answer'), answer: assistantAnswerSchema }),
])
export type AssistantTurnInput = v.InferOutput<typeof assistantTurnInputSchema>

/**
 * What this deployment's assistant can do, read before the prompt box is offered.
 *
 * `available` is about the MODEL, not about permissions: a deployment that wired no provider
 * cannot answer a prompt, and hiding the box is a better answer than a 503 on every submission.
 * The action list is published rather than assumed so a deployment that narrows the catalog
 * narrows the suggestions with it, instead of advertising an action the engine would decline.
 */
export const assistantCapabilitySchema = v.object({
  available: v.boolean(),
  actions: v.array(assistantActionIdSchema),
})
export type AssistantCapability = v.InferOutput<typeof assistantCapabilitySchema>
