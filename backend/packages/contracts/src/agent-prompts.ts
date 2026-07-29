import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Per-workspace agent system-prompt overrides.
//
// Every built-in agent kind ships with a system prompt authored in
// `@cat-factory/agents` and identified as `id@vN` (see PROMPT_VERSIONS). A workspace
// can REPLACE that base prompt for a kind — the text that would otherwise come from
// `systemPromptFor(kind)` — from the pipeline builder, where the kinds are actually
// chosen.
//
// The store is an APPEND-ONLY revision log per `(workspace, agentKind)`, and the
// HIGHEST revision is the live one. That is what makes "switch back to an older
// version" a first-class operation rather than a destructive edit: restoring is
// appending the old text again (recorded as `restoredFrom`), so the log always reads
// forward and two concurrent editors can never silently overwrite each other — the
// second one's insert collides on the revision number and is refused.
//
// A revision whose `text` is `null` means "follow the SHIPPED built-in prompt". It is
// not the same as having no revisions at all (that is simply an untouched kind): it
// records that someone deliberately went back to the built-in, and it keeps the
// workspace tracking the built-in as the product's own prompt is bumped, rather than
// pinning a stale copy of its text.
// ---------------------------------------------------------------------------

/** Upper bound on a stored override, generous enough for the longest built-in prompt. */
export const MAX_AGENT_PROMPT_CHARS = 40_000

/**
 * One entry in a kind's prompt-revision log. `text: null` is the "follow the built-in"
 * revision; any other value REPLACES the kind's base system prompt for this workspace.
 */
export const agentPromptRevisionSchema = v.object({
  agentKind: v.string(),
  /** 1-based, monotonic within `(workspace, agentKind)`. The highest one is live. */
  revision: v.number(),
  /** The override text, or `null` for "follow the shipped built-in prompt". */
  text: v.nullable(v.string()),
  /**
   * The revision this one was restored from, when it was created by picking an entry out
   * of the history rather than by typing new text. Presentation only — the restored text
   * is copied into this revision, so the log never has to be replayed to read the live
   * prompt.
   */
  restoredFrom: v.optional(v.number()),
  createdAt: v.number(),
  /** Internal user id (`usr_*`) of the author, absent for a system/dev write. */
  createdBy: v.optional(v.string()),
})
export type AgentPromptRevision = v.InferOutput<typeof agentPromptRevisionSchema>

/**
 * The live state of ONE agent kind's prompt in a workspace: what ships, what is live now,
 * and the full history to restore from. `builtin` is resolved from the running deployment's
 * agent-kind registry, so a kind a deployment registered itself is editable exactly like a
 * built-in one.
 */
export const agentPromptDetailSchema = v.object({
  agentKind: v.string(),
  /** The prompt the deployment ships for this kind — the baseline an override replaces. */
  builtinText: v.string(),
  /**
   * The `id@vN` label of the shipped prompt when it is under version control, so the editor
   * can say which shipped revision the override was forked from. Absent for a kind whose
   * prompt carries no number (see `promptVersionLabel`).
   */
  builtinVersionLabel: v.optional(v.string()),
  /** The text that will actually be sent: the live override, else `builtinText`. */
  effectiveText: v.string(),
  /** True when a live override replaces the built-in (i.e. the head revision has text). */
  customized: v.boolean(),
  /** The whole revision log, newest first. Empty for an untouched kind. */
  revisions: v.array(agentPromptRevisionSchema),
})
export type AgentPromptDetail = v.InferOutput<typeof agentPromptDetailSchema>

/**
 * One row of the workspace's override index: which kinds deviate from the built-in. Read by
 * the pipeline builder to badge the customized steps without fetching every prompt body.
 */
export const agentPromptSummarySchema = v.object({
  agentKind: v.string(),
  revision: v.number(),
  /** False when the head revision is a "back to the built-in" entry. */
  customized: v.boolean(),
  updatedAt: v.number(),
})
export type AgentPromptSummary = v.InferOutput<typeof agentPromptSummarySchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Append a revision. `text: null` goes back to the shipped built-in; `restoredFrom` records
 * that the text was lifted out of the history rather than typed, and is validated against the
 * log (an unknown revision is refused rather than stored as a dangling reference).
 */
export const saveAgentPromptSchema = v.object({
  text: v.nullable(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_AGENT_PROMPT_CHARS)),
  ),
  restoredFrom: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
})
export type SaveAgentPromptInput = v.InferOutput<typeof saveAgentPromptSchema>
