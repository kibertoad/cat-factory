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
//
// Declaring a set therefore has to be measured against the default it replaces, not just against
// the issue that asked for it: everything the default carried and a container CAN use has to be
// asked for by name, or the declaration is itself a capability loss. That is what `Monitor` and
// the web tools are doing in the list below.
// ---------------------------------------------------------------------------

/**
 * Every built-in tool a run asks the CLI for, and the ONE value that rides both `--tools` and the
 * `--allowedTools` re-grant.
 *
 * One value rather than two derived ones, because the allow-list turned out to be ADDITIVE rather
 * than inert: a name in it is UNLOCKED, not merely re-permitted (measured: `--allowedTools
 * "Bash,Grep"` yields the default set PLUS `Glob` and `Grep`). Two independently-computed lists
 * would therefore not merely disagree, they would silently re-grant what the other withheld.
 *
 * Deliberately OVER-inclusive, and safe to be, because a name the build does not have is dropped
 * silently rather than refused. The cost is one-directional: a name the CLI HAS and this list
 * LACKS is a capability silently removed from every run. So the list is measured against the
 * headless default it replaces, not only against what was wanted, and when the CLI gains a tool a
 * container agent can use, it is added here.
 *
 * A name 2.1.246 does not serve is kept for one of two measured reasons, and they are different
 * facts worth keeping apart (each probed alone, reading the `init` event's own `tools` array):
 *
 *  - ALIASED onto a successor, so the old spelling still buys the capability: `BashOutput` grants
 *    `TaskOutput`, `KillBash` and `KillShell` both grant `TaskStop`, `Agent` grants `Task`.
 *  - DROPPED outright (`ListMcpResources`, `ReadMcpResource`, `MultiEdit`, `NotebookRead`,
 *    `TodoWrite`), and kept only because the harness image is pinned per workspace, so one build
 *    of this source faces several CLI versions and an older one still serves them.
 *
 * The second category is why the CURRENT spelling has to be listed beside the old one rather than
 * instead of it: `ListMcpResources`/`ReadMcpResource` were carried alone, and since neither is an
 * alias, every tool-server run reached its resources through nothing at all.
 *
 * `WebSearch`/`WebFetch` are unconditional, which is a deliberate reversal of the first cut of this
 * module. They were gated on the job's `webSearch` flag, which states whether OUR PROXY can serve
 * web research for the run's account (see `resolveWebSearchAvailability`, whose whole rationale is
 * that Pi's proxy-backed tools "would just fail/return nothing" without a key). The CLI's web tools
 * are not proxy-backed: the vendor the leased subscription already pays serves them, and they work
 * on a deployment with no search provider wired at all. Gating them on that flag therefore withheld
 * a WORKING capability on the strength of an unrelated fact, which is the opposite of the
 * pass-through an unwired capability owes. The flag that would legitimately withhold them is a
 * per-run "may this run reach the web" POLICY, which this platform does not have today; when it
 * gains one, it gates here and on the Pi path together.
 */
export const CLAUDE_TOOL_SET: readonly string[] = [
  'Agent',
  'Bash',
  'BashOutput',
  'Edit',
  'Glob',
  'Grep',
  'KillBash',
  'KillShell',
  'ListMcpResources',
  'ListMcpResourcesTool',
  // Waits on the background shells `Bash(run_in_background)` starts. A tool in its own right
  // (measured: `Monitor` grants `Monitor`), not an alias of the retired kill/output pair, and it
  // is in the headless default, so omitting it was this declaration's own capability loss.
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Read',
  'ReadMcpResource',
  'ReadMcpResourceTool',
  'Skill',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  // Loads the schemas of tools a build defers rather than declaring up front. Dropped by 2.1.246
  // (measured, with and without a tool server wired), and asked for anyway under the
  // over-inclusive rule: a run wiring several tool servers is exactly the shape a build that
  // defers tool schemas would hand one to.
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
]

/**
 * One capability the run genuinely cannot do without, and every CLI spelling that satisfies it.
 *
 * The floor is expressed as CAPABILITIES rather than as names because {@link CLAUDE_TOOL_SET}
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
  /** The built-in tools this run asks for; see {@link CLAUDE_TOOL_SET}. */
  tools: readonly string[]
  /**
   * Whether to DECLARE that set with `--tools`, or take whatever the CLI defaults to.
   *
   * False for an `ambientAuth` run, which is the one case where the CLI is not this image's. A
   * name the build does not carry is dropped silently, which is what makes {@link CLAUDE_TOOL_SET}
   * safe to be over-inclusive, but that rule is about tool NAMES. An unrecognised FLAG is a
   * different failure: the CLI exits before the run starts. Everywhere else the image pins the
   * version and the flag is measured against it; on a developer's own machine the harness knows
   * neither which `claude` is on the PATH nor how old it is, and the cost of guessing wrong is
   * every local native run, not a thinner tool surface on one.
   */
  declareTools: boolean
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
    ...(opts.declareTools ? ['--tools', opts.tools.join(',')] : []),
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
 *
 * `requested` is what the argv actually DECLARED, so an ambient run (which declares nothing, see
 * {@link claudeCliArgs}) passes none and the line says the surface is the CLI's own default. The
 * floor is still read back there: "the default set carries no search tool" and "we asked for one
 * and did not get it" are both worth a line, and they are not the same fact or the same fix.
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
      ...(requested.length > 0 ? { requestedTools: [...requested] } : { toolsDeclared: false }),
      ...cliVersion,
    })
    return
  }
  const granted = new Set(event.tools.filter((t): t is string => typeof t === 'string'))
  const missing = CLAUDE_TOOL_FLOOR.filter((c) => !c.spellings.some((s) => granted.has(s))).map(
    (c) => c.capability,
  )
  const fields = {
    ...(requested.length > 0 ? { requestedTools: [...requested] } : { toolsDeclared: false }),
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
