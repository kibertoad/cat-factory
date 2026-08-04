import { SUBAGENT_TOOL_NAMES } from './claude-stream.js'

// The harness's no-progress guard: the live anti-rabbithole bound every agent run is held to,
// plus the tool-name vocabulary it classifies calls with and the limits it reads from the
// environment. Extracted from `pi.ts` when the guard stopped being Pi's: it now also drives the
// claude-code subscription runner (`agent-runner.ts` feeds it via `observeSignal`), so the two
// harnesses share ONE definition of "this run has stopped making progress" — and the tool-name
// sets below deliberately cover both CLIs' vocabularies.

/**
 * Tool-call signal read off a streamed Pi event, or undefined if not a tool call. Exported for
 * `runPi`'s span emitter, which reads the same event for its per-tool trace spans.
 */
export function toolCallSignal(
  event: Record<string, unknown>,
): { name: string; isError: boolean } | undefined {
  // `tool_execution_end` is the canonical per-call stream event (statsFromEvents
  // counts the same one), so the guard reads it and nothing else — no double count.
  if (event.type !== 'tool_execution_end') return undefined
  const name = typeof event.toolName === 'string' ? event.toolName : ''
  return { name, isError: event.isError === true }
}

/** Tunable bounds for the {@link ProgressGuard}. */
export interface ProgressGuardLimits {
  /**
   * Abort once the agent has made this many NON-exploration tool calls without ever
   * using a file-editing tool (see `FILE_EDIT_TOOLS`). The signature of the credential
   * rabbit-hole that motivated this: probing the environment (`bash`/exec) endlessly
   * without implementing anything. Read-only exploration (`read`/`grep`/… — see
   * `EXPLORATION_TOOLS`) and planning (`todo`) do NOT count, so a large task that
   * legitimately reads/searches many files before its first edit is not killed for it.
   * Disabled when `expectsEdits` is false (e.g. the assess-only merger / Blueprinter,
   * which legitimately edit nothing). Note this bound only guards the run UNTIL its
   * first edit: once the agent has edited a file at all, it has demonstrably started
   * the work, so only `maxConsecutiveErrors` guards a later stall.
   */
  maxToolCallsWithoutEdit: number
  /**
   * Abort after this many consecutive failing tool calls — the agent is stuck
   * retrying an operation that keeps failing rather than making progress.
   */
  maxConsecutiveErrors: number
  /**
   * Abort after this many consecutive web-search/web-fetch calls with no other tool
   * call in between. Web tools are read-only exploration (they don't count toward the
   * no-edit bound), so without this a model could rabbit-hole on searches indefinitely
   * without ever tripping a guard. Any non-web tool call resets the streak. Optional:
   * defaults to {@link DEFAULT_PROGRESS_GUARD_LIMITS} when a caller builds limits
   * without it.
   */
  maxConsecutiveWebCalls?: number
  /**
   * Abort after this many consecutive MCP tool-server calls (`mcp__*`) with no other
   * tool call in between: the tool-server analogue of `maxConsecutiveWebCalls`, and
   * present for the same reason. An `mcp__*` call is exempt from the no-edit bound (see
   * `isMcpToolCall`), so without a streak of its own a run could query a tool server
   * indefinitely without tripping any guard. Any non-MCP tool call resets the streak.
   * Optional: defaults to {@link DEFAULT_PROGRESS_GUARD_LIMITS}.
   */
  maxConsecutiveMcpCalls?: number
  /**
   * Abort after this many consecutive calls that are EXEMPT from the no-edit bound
   * (planning, read-only exploration, subagent dispatch, `mcp__*`) with no action call
   * in between. The backstop that makes each individual exemption mean "not counted"
   * rather than "unbounded": every per-family streak above resets on any call outside
   * its own family, so a run alternating `web_search` with `mcp__issues__search` (or
   * with `read`) trips none of them and, having never made an action call, never
   * reaches `maxToolCallsWithoutEdit` either. Only the job's wall-clock ceiling
   * bounded that.
   *
   * Deliberately far above every family cap, because it is not a research bound and
   * must not become one: reading a hundred files before the first edit is legitimate
   * work-up, and any `bash`/edit/action call resets the streak. Optional: defaults to
   * {@link DEFAULT_PROGRESS_GUARD_LIMITS}.
   */
  maxConsecutiveNonActionCalls?: number
}

// `satisfies` (not a type annotation) so each property keeps its concrete `number`
// type — `maxConsecutiveWebCalls` is optional on the interface (callers may omit it),
// but the defaults always define it, so consumers reading it off here get a `number`.
export const DEFAULT_PROGRESS_GUARD_LIMITS = {
  // Counts only non-exploration, non-planning calls (see EXPLORATION_TOOLS), so the
  // ceiling can be generous without risking a false kill on a read-heavy large task.
  maxToolCallsWithoutEdit: 40,
  maxConsecutiveErrors: 12,
  // A genuine research burst is a handful of searches; an uninterrupted run of this
  // many web calls (with no read/edit/bash between) is a search loop, not progress.
  maxConsecutiveWebCalls: 25,
  // Looser than the web cap: a tool server is usually the agent's route to the SYSTEM OF
  // RECORD (the issue tracker, the advisory database, the design source), and reading a
  // list and then each of its items is a normal opening move, not a rabbit-hole. A run
  // that makes this many in a row with no read, edit or bash between is looping.
  maxConsecutiveMcpCalls: 40,
  // Well clear of every family cap above, and of any plausible read-up: a run that makes
  // this many exempt calls with not one action call between them has stopped converging,
  // whatever mix of reads, searches and lookups it is cycling through. Sized as a
  // backstop rather than a judgement, because the families are where judgement belongs.
  maxConsecutiveNonActionCalls: 200,
} satisfies ProgressGuardLimits

// Tool names that mutate files, so a call to one clears the no-edit suspicion. Kept
// broad on purpose: different models/extensions name the same capability differently
// (`edit`/`write`, but also `apply_patch`/`patch`/`str_replace`/`multiedit`/`create`),
// and a false "no edits" reading would kill a run that IS making changes. Matched
// case-insensitively. NOTE: a file written purely via `bash` (e.g. a heredoc) is not
// recognised here — broaden or move to a working-tree signal if that becomes common.
const FILE_EDIT_TOOLS = new Set([
  'edit',
  'write',
  'apply_patch',
  'patch',
  'str_replace',
  'multiedit',
  'create',
  // Claude Code tool names (the guard now runs on the claude-code stream too): Edit/Write/
  // MultiEdit already match above; NotebookEdit is its own tool.
  'notebookedit',
])

// Planning/bookkeeping tools that are neither file edits nor the environment-probing
// the no-edit bound targets — the todo list the agent maintains as it works. These do
// NOT count toward `maxToolCallsWithoutEdit`: a run that diligently updates a long
// todo list before its first edit (common on a large task) would otherwise be killed
// for "no edits" purely from planning calls. They still reset the consecutive-error
// streak (a successful call means the agent isn't wedged). Matched case-insensitively.
// `todo` is Pi's tool; `TodoWrite` and the incremental `TaskCreate`/`TaskUpdate` pair are
// Claude Code's plan vocabularies — all pure bookkeeping, exempt from the no-edit bound.
const PLANNING_TOOLS = new Set(['todo', 'todowrite', 'taskcreate', 'taskupdate'])

// A subagent dispatch (Claude Code's `Agent`/`Task`) is exempt from the no-edit bound because
// the parent stream CANNOT see the edits it makes: only the dispatch and its terminal
// tool_result appear there, while every Edit/Write the subagent performs happens on a transcript
// the guard never reads (`subagents.ts` watches those separately, for usage/progress only). So a
// coder that fans its implementation out across subagents looks, to this guard, like a run making
// dozens of action calls and zero edits — and would be killed for making excellent progress.
// Counting them as edits instead would be worse (a read-only research subagent would then clear
// the suspicion the bound exists to hold), so they are neutral: they neither count toward the
// bound nor satisfy it. Sourced from the same set the slice tracker matches on, lower-cased for
// this module's case-insensitive comparison.
const SUBAGENT_DISPATCH_TOOLS = new Set([...SUBAGENT_TOOL_NAMES].map((name) => name.toLowerCase()))

// Read-only exploration tools: reading/searching the repo is legitimate work-up to an
// edit, NOT the environment-probing the no-edit bound targets, so they don't count
// toward `maxToolCallsWithoutEdit` (a large task may read/search dozens of files
// before its first edit). The bound thus counts only "action" calls — chiefly `bash`
// (the credential rabbit-hole's vector) — that have yet to produce an edit. Kept broad
// since models/extensions name the same capability differently. Matched case-insensitively.
const EXPLORATION_TOOLS = new Set([
  'read',
  'grep',
  'search',
  'glob',
  'ls',
  'list',
  'find',
  'tree',
  'cat',
  'view',
  'head',
  'tail',
  'stat',
  // rpiv-web-tools (Pi) + Claude Code's WebSearch/WebFetch: querying/reading the web is
  // read-only research up to an edit, not the environment-probing the no-edit bound targets.
  'web_search',
  'web_fetch',
  'websearch',
  'webfetch',
])

// The web-tool calls, tracked separately so an unbounded run of them (with no other tool
// call between) can be caught as a search loop — see `maxConsecutiveWebCalls`. Covers both
// Pi's `web_search`/`web_fetch` and Claude Code's `WebSearch`/`WebFetch`.
const WEB_TOOLS = new Set(['web_search', 'web_fetch', 'websearch', 'webfetch'])

// A call to a tool server (MCP). Every MCP client names these `mcp__<server>__<tool>`, and
// the prefix is the ONLY thing the harness can know about them: what a given server's tools
// do is a backend registration this image has never seen, so the guard classifies by shape.
//
// Matched, rather than enumerated in EXPLORATION_TOOLS, because the set is open: it is
// whatever tool servers the running kind was wired with. A prefix test is also why this is a
// function, `name.startsWith` on the already-lower-cased name, so `MCP__Issues__search`
// classifies the same as `mcp__issues__search`.
function isMcpToolCall(loweredName: string): boolean {
  return loweredName.startsWith('mcp__')
}

// Whether a call is EXEMPT from the no-edit bound: planning and bookkeeping, read-only
// exploration, a subagent dispatch, or a tool-server call. One predicate rather than the
// four tests inlined at the branch, because the combined non-action streak and the no-edit
// exemption must be the SAME set: a family exempted in one place and missed in the other is
// either an unbounded loop or a run killed for a call the bound says it may make.
function isNonActionToolCall(loweredName: string): boolean {
  return (
    PLANNING_TOOLS.has(loweredName) ||
    EXPLORATION_TOOLS.has(loweredName) ||
    SUBAGENT_DISPATCH_TOOLS.has(loweredName) ||
    isMcpToolCall(loweredName)
  )
}

/** Read {@link ProgressGuardLimits} from the environment, falling back to the defaults. */
export function progressGuardLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProgressGuardLimits {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  return {
    maxToolCallsWithoutEdit: num(
      env.JOB_MAX_TOOLCALLS_WITHOUT_EDIT,
      DEFAULT_PROGRESS_GUARD_LIMITS.maxToolCallsWithoutEdit,
    ),
    maxConsecutiveErrors: num(
      env.JOB_MAX_CONSECUTIVE_TOOL_ERRORS,
      DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveErrors,
    ),
    maxConsecutiveWebCalls: num(
      env.JOB_MAX_CONSECUTIVE_WEB_CALLS,
      DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveWebCalls,
    ),
    maxConsecutiveMcpCalls: num(
      env.JOB_MAX_CONSECUTIVE_MCP_CALLS,
      DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveMcpCalls,
    ),
    maxConsecutiveNonActionCalls: num(
      env.JOB_MAX_CONSECUTIVE_NON_ACTION_CALLS,
      DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveNonActionCalls,
    ),
  }
}

/**
 * Apply per-knob overrides onto a base set of guard limits, ENFORCING loosen-only: an
 * override can only RAISE a knob (more headroom), never lower it below the base. A
 * larger value is more lenient for every knob (more no-edit tool calls / errors / web
 * calls tolerated), so each result is `max(base, override)`. This is a hard guarantee,
 * not a convention — a tuning entry (built-in or a custom kind's, which reaches this via
 * an untrusted job body) that supplies a value TIGHTER than the base is clamped back up
 * to the base rather than aborting a legitimately-progressing run. An absent/undefined
 * knob keeps the base value untouched.
 */
export function mergeGuardLimits(
  base: ProgressGuardLimits,
  overrides: Partial<ProgressGuardLimits> | undefined,
): ProgressGuardLimits {
  if (!overrides) return base
  const loosen = (b: number, o: number | undefined): number =>
    typeof o === 'number' ? Math.max(b, o) : b
  return {
    maxToolCallsWithoutEdit: loosen(
      base.maxToolCallsWithoutEdit,
      overrides.maxToolCallsWithoutEdit,
    ),
    maxConsecutiveErrors: loosen(base.maxConsecutiveErrors, overrides.maxConsecutiveErrors),
    // The streak knobs are optional on the interface (callers may omit them), so fall back
    // to the default before loosening: it keeps `loosen`'s base a concrete number.
    maxConsecutiveWebCalls: loosen(
      base.maxConsecutiveWebCalls ?? DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveWebCalls,
      overrides.maxConsecutiveWebCalls,
    ),
    maxConsecutiveMcpCalls: loosen(
      base.maxConsecutiveMcpCalls ?? DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveMcpCalls,
      overrides.maxConsecutiveMcpCalls,
    ),
    maxConsecutiveNonActionCalls: loosen(
      base.maxConsecutiveNonActionCalls ??
        DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveNonActionCalls,
      overrides.maxConsecutiveNonActionCalls,
    ),
  }
}

/**
 * Live anti-rabbithole guard: fed each streamed Pi event, it returns a diagnostic
 * reason the moment a run has plainly stopped making progress, so the harness can
 * kill Pi early instead of letting it burn the whole budget (and then surface a
 * useful failure instead of a generic "no file changes"). Pure and incremental so
 * it can be unit-tested over a fixed event sequence.
 */
export class ProgressGuard {
  private toolCalls = 0
  private edits = 0
  private consecutiveErrors = 0
  private consecutiveWebCalls = 0
  private consecutiveMcpCalls = 0
  private consecutiveNonActionCalls = 0

  constructor(
    private readonly limits: ProgressGuardLimits,
    /** When false (assess-only runs like the merger), the no-edit bound is skipped. */
    private readonly expectsEdits: boolean = true,
  ) {}

  /** Feed one parsed Pi event; returns a diagnostic reason when the run should abort, else null. */
  observe(event: Record<string, unknown>): string | null {
    const tool = toolCallSignal(event)
    if (!tool) return null
    return this.observeSignal(tool)
  }

  /**
   * Feed one already-parsed tool-call signal (name + error flag), returning a diagnostic reason
   * when the run should abort, else null. Split out of {@link observe} so a caller whose stream
   * is NOT Pi's `tool_execution_end` envelope — the claude-code runner, which correlates a
   * `tool_use` block's name with its `tool_result`'s `is_error` — can drive the SAME guard logic
   * without synthesising a fake Pi event.
   */
  observeSignal(tool: { name: string; isError: boolean }): string | null {
    const name = tool.name.toLowerCase()
    // The error streak tracks ANY tool call (a planning call still proves the agent
    // isn't wedged in a failing-op loop), so it's updated before the planning skip.
    this.consecutiveErrors = tool.isError ? this.consecutiveErrors + 1 : 0
    if (this.consecutiveErrors >= this.limits.maxConsecutiveErrors) {
      return (
        `no progress: ${this.consecutiveErrors} consecutive failing tool calls — the agent is stuck ` +
        `retrying a failing operation rather than making progress. Aborting.`
      )
    }

    // Web search/fetch loop: web tools are read-only (they don't count toward the
    // no-edit bound), so guard them separately — an uninterrupted streak of them is a
    // research rabbit-hole. Any non-web tool call resets the streak.
    if (WEB_TOOLS.has(name)) {
      this.consecutiveWebCalls++
      const webCap =
        this.limits.maxConsecutiveWebCalls ?? DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveWebCalls
      if (this.consecutiveWebCalls >= webCap) {
        return (
          `no progress: ${this.consecutiveWebCalls} consecutive web search/fetch calls without ` +
          `any other action — the agent is stuck researching instead of doing the work. Aborting.`
        )
      }
    } else {
      this.consecutiveWebCalls = 0
    }

    // Tool-server (MCP) calls: bounded as their own streak for exactly the reason the web
    // streak exists. They are exempt from the no-edit bound below, and an exemption with no
    // counter-bound is a loop the guard cannot see. Any non-MCP call resets it.
    if (isMcpToolCall(name)) {
      this.consecutiveMcpCalls++
      const mcpCap =
        this.limits.maxConsecutiveMcpCalls ?? DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveMcpCalls
      if (this.consecutiveMcpCalls >= mcpCap) {
        return (
          `no progress: ${this.consecutiveMcpCalls} consecutive tool-server (MCP) calls without ` +
          `any other action. The agent is stuck querying its tools instead of doing the work. ` +
          `Aborting.`
        )
      }
    } else {
      this.consecutiveMcpCalls = 0
    }

    // Planning, read-only exploration, subagent-dispatch and tool-server calls don't count
    // toward the no-edit bound (see `isNonActionToolCall`): only "action" calls without an
    // edit do.
    //
    // An `mcp__*` call is exempt for the same reason a `read` is: the bound targets the
    // credential rabbit-hole (endless `bash` probing with nothing implemented), and reaching
    // a registered tool server is the platform TELLING the agent to look something up
    // ("prefer them over guessing"). Counting them would abort an edits-expected kind for
    // consulting the issue tracker the deployment wired for it, punishing the run for
    // following its own prompt. They are neutral rather than edit-satisfying, exactly like a
    // subagent dispatch: a read-only lookup must not clear the suspicion the bound holds.
    //
    // The exempt calls carry ONE streak of their own, and it is what keeps every exemption
    // above from adding up to an unbounded run: each per-family cap resets on any call
    // outside its family, so alternating two exempt families trips neither, and a run that
    // never makes an action call never reaches the no-edit bound either.
    if (isNonActionToolCall(name)) {
      this.consecutiveNonActionCalls++
      const nonActionCap =
        this.limits.maxConsecutiveNonActionCalls ??
        DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveNonActionCalls
      if (this.consecutiveNonActionCalls >= nonActionCap) {
        return (
          `no progress: ${this.consecutiveNonActionCalls} consecutive read-only calls (searching, ` +
          `reading, tool-server lookups, subagent dispatches) with no action call between them. ` +
          `The agent is cycling through research instead of doing the work. Aborting.`
        )
      }
      return null
    }
    this.consecutiveNonActionCalls = 0
    this.toolCalls++
    if (FILE_EDIT_TOOLS.has(name)) this.edits++

    if (
      this.expectsEdits &&
      this.edits === 0 &&
      this.toolCalls >= this.limits.maxToolCallsWithoutEdit
    ) {
      return (
        `no progress: ${this.toolCalls} tool calls and not one file edit — the agent is exploring or ` +
        `probing the environment without implementing anything. Aborting before it burns the whole run.`
      )
    }
    return null
  }
}
