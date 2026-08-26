import type { Logger } from './logger.js'

// ---------------------------------------------------------------------------
// The Claude Code CLI's INVOCATION surface: which of its built-in tools a run asks for, the argv
// that asks, and the read-back that says what the CLI actually granted.
//
// The three belong together because they are one decision seen from three sides. Before this
// module the harness declared nothing and took whatever the CLI's headless default happened to
// be, which drifted across CLI versions: 2.1.226 offered the plan tools, 2.1.245 did not, and
// nothing in the run said so. Both halves of that default were wrong for a disposable container:
// no `Grep`/`Glob` (so every search went through `Bash` and counted against the progress guard's
// no-edit budget), no plan tools (so `step.progress` had no signal to lift), and a dozen tools
// (`CronCreate`, `DesignSync`, `EnterWorktree`, `ScheduleWakeup`, `SendMessage`, `Workflow`,
// `ReportFindings`, …) an agent in a per-run container can act on none of.
// ---------------------------------------------------------------------------

/**
 * The web tools, split out because they are the one part of the set a RUN decides rather than the
 * image: the backend states per job whether this deployment serves web research at all, and a
 * harness that advertised the tools anyway would be offering a capability the deployment withheld.
 * Same rule the Pi side already follows, where the web-tools extension is configured only when a
 * provider is actually wired.
 */
export const CLAUDE_WEB_TOOLS: readonly string[] = ['WebSearch', 'WebFetch']

/**
 * Every non-web built-in tool a run asks the CLI for.
 *
 * Deliberately OVER-inclusive, and safe to be: the CLI drops a name it does not have without
 * error (measured: `MultiEdit` and `TodoWrite` are ignored by 2.1.245), while a name it HAS and
 * this list lacks is a capability silently removed from every run. The harness image is pinned
 * per workspace, so one image faces several CLI versions; historical and renamed spellings
 * (`Task` ⇄ `Agent`, `MultiEdit`, `TodoWrite`, `KillBash` ⇄ `KillShell`) are kept for that reason
 * alone. When the CLI gains a tool a container agent can use, add it here.
 */
const CLAUDE_CORE_TOOLS: readonly string[] = [
  'Agent',
  'Bash',
  'BashOutput',
  'Edit',
  'Glob',
  'Grep',
  'KillBash',
  'KillShell',
  'ListMcpResources',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Read',
  'ReadMcpResource',
  'Skill',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'Write',
]

/**
 * The whole declarable set: {@link CLAUDE_CORE_TOOLS} plus {@link CLAUDE_WEB_TOOLS}. Exported as
 * the vocabulary the run's request is drawn from; what a given run actually asks for is
 * {@link claudeRequestedTools}.
 */
export const CLAUDE_TOOL_SET: readonly string[] = [...CLAUDE_CORE_TOOLS, ...CLAUDE_WEB_TOOLS]

/**
 * The built-in tools THIS run asks for: the whole set, minus the web tools when the backend did
 * not declare web research available for the job.
 *
 * The same value feeds `--tools` AND the `--allowedTools` re-grant, and it is threaded rather than
 * re-derived at each site because the allow-list turned out to be ADDITIVE rather than inert: a
 * name in it is UNLOCKED, not merely re-permitted (measured: `--allowedTools "Bash,Grep"` yields
 * the default set PLUS `Glob` and `Grep`). Two independently-computed lists would therefore not
 * merely disagree, they would silently re-grant what the other withheld.
 */
export function claudeRequestedTools(webTools: boolean): readonly string[] {
  return webTools ? CLAUDE_TOOL_SET : CLAUDE_CORE_TOOLS
}

/**
 * One capability the run genuinely cannot do without, and every CLI spelling that satisfies it.
 *
 * The floor is expressed as CAPABILITIES rather than as names because {@link CLAUDE_CORE_TOOLS}
 * is over-inclusive on purpose: a literal "warn on anything requested but absent" would fire on
 * every single run for the alternate spellings this image carries for other CLI versions, and a
 * warning that is always on is one nobody reads. A capability with no granted spelling is the
 * fact worth a line: it means an upstream rename or removal took a tool out of every run of this
 * image, which otherwise surfaces days later as an agent behaving oddly.
 */
interface ClaudeToolCapability {
  capability: string
  spellings: readonly string[]
}

const CLAUDE_TOOL_FLOOR: readonly ClaudeToolCapability[] = [
  { capability: 'shell', spellings: ['Bash'] },
  { capability: 'read', spellings: ['Read'] },
  { capability: 'write', spellings: ['Write'] },
  { capability: 'edit', spellings: ['Edit', 'MultiEdit'] },
  { capability: 'search', spellings: ['Grep'] },
  { capability: 'glob', spellings: ['Glob'] },
  { capability: 'subagents', spellings: ['Task', 'Agent'] },
  // The plan signal the harness lifts into `step.subtasks` / `step.progress`, in the two
  // vocabularies the CLI has used for it (see `progress.ts`, which reads both).
  { capability: 'plan', spellings: ['TaskCreate', 'TodoWrite'] },
]

/** The floor, exported so a test can assert every spelling is one this harness actually asks for. */
export const CLAUDE_TOOL_CAPABILITIES: readonly ClaudeToolCapability[] = CLAUDE_TOOL_FLOOR

/**
 * The `claude` argv for one run, in the order the CLI's variadic flags require.
 *
 * `--tools` and `--allowedTools` are both declared `<tools...>`, so each swallows any trailing
 * POSITIONAL argument as another tool name; only a following `--flag` terminates them. The prompt
 * therefore stays on stdin (see `streamCli`) and every flag here is placed before the variadic
 * pair or introduced by its own `--`, so a new flag cannot be eaten by the one in front of it.
 */
export function claudeCliArgs(opts: {
  model: string
  /** The built-in tools this run asks for; see {@link claudeRequestedTools}. */
  tools: readonly string[]
  /** `--mcp-config` + `--strict-mcp-config` + any `--allowedTools`; empty when no server is wired. */
  mcpArgs: readonly string[]
  /** `--append-system-prompt <prompt>`, or empty when the prompt was folded into stdin. */
  appendArgs: readonly string[]
}): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // The per-run container IS the sandbox, and the run is fully headless (no one to approve a
    // tool call) — so bypass permissions entirely. `acceptEdits` would auto-accept file edits but
    // still gate Bash, which in `-p` mode is then denied, leaving the agent unable to run
    // builds/tests/git to verify its work.
    '--permission-mode',
    'bypassPermissions',
    '--model',
    opts.model,
    // Declared rather than defaulted: see this module's header for what the default set costs.
    '--tools',
    opts.tools.join(','),
    ...opts.mcpArgs,
    ...opts.appendArgs,
  ]
}

/**
 * Read the CLI's startup report (`{"type":"system","subtype":"init"}`) back against what this run
 * asked for, and say when a required capability is missing.
 *
 * The same pairing, and for the same reason, as `assertOnboardingKeysCurrent`: the CLI is the only
 * one who knows what it granted, it says so exactly once before the first model call, and pairing
 * that answer with the CLI version is what makes an upstream rename diffable instead of a mystery.
 * The version comes off the event itself (`claude_code_version`) rather than an env var the image
 * would have to remember to bake.
 *
 * Best-effort and never throws: a run whose tool surface is short is still a run, and the honest
 * disposition for a floor this image cannot verify is to SAY it could not be read, not to fail the
 * job and not to stay silent (which reads exactly like a satisfied request).
 */
export function assertClaudeToolsCurrent(
  event: Record<string, unknown>,
  requested: readonly string[],
  log: Logger | undefined,
): void {
  if (!log || event.type !== 'system' || event.subtype !== 'init') return
  const version =
    typeof event.claude_code_version === 'string' ? event.claude_code_version : undefined
  const cliVersion = version ? { cliVersion: version } : {}
  if (!Array.isArray(event.tools)) {
    log.warn('claude-code announced no tool list, so this run has an unverified tool surface', {
      requestedTools: [...requested],
      ...cliVersion,
    })
    return
  }
  const granted = new Set(event.tools.filter((t): t is string => typeof t === 'string'))
  const missing = CLAUDE_TOOL_FLOOR.filter((c) => !c.spellings.some((s) => granted.has(s))).map(
    (c) => c.capability,
  )
  const fields = {
    requestedTools: [...requested],
    grantedTools: [...granted].sort(),
    ...cliVersion,
  }
  if (missing.length > 0) {
    log.warn('claude-code granted no tool for a capability this run requires', {
      ...fields,
      missingCapabilities: missing,
    })
    return
  }
  log.info('claude-code tool set granted', fields)
}
