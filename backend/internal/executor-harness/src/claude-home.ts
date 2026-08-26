import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  claudeAllowedToolPatterns,
  mcpServerSecretValues,
  writeClaudeMcpConfig,
  type McpServerSpec,
  type SkillSpec,
} from './agent-capabilities.js'
import type { Logger } from './logger.js'
import { assertOnboardingKeysCurrent, writeOnboardingPreseed } from './onboarding-preseed.js'
import { registerKnownSecrets } from './redact.js'
import { retainSessionTranscripts } from './transcript-retention.js'

// ---------------------------------------------------------------------------
// The PER-RUN Claude Code config home: everything written for one claude-code job and torn down
// with it — the isolated `CLAUDE_CONFIG_DIR`, its onboarding pre-seed, the run's native skills,
// its MCP config, and the child env that points the CLI at all of it.
//
// The sibling of `codex-home.ts`, extracted from `runClaudeCode` for the same reason: the run
// loop's own job is streaming and reducing the CLI's events, while this is a directory with a
// lifecycle that holds a credential.
//
// CRITICAL, and why it is a temp dir rather than anything under the checkout: several handlers
// finish with `git add -A` + push, so a `.claude/` directory inside `opts.cwd` would publish any
// cached credential to the PR branch.
// ---------------------------------------------------------------------------

/** What one claude-code job needs written into its own home. */
export interface ClaudeHomeOptions {
  /** The decrypted subscription OAuth token. Required unless `ambientAuth`. */
  subscriptionToken?: string
  /**
   * Anthropic-compatible base URL for a non-Anthropic Claude-Code vendor (GLM/Kimi): present ⇒
   * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, absent ⇒ CLAUDE_CODE_OAUTH_TOKEN.
   */
  subscriptionBaseUrl?: string
  /** Run the developer's own CLI login instead: no isolated home, nothing installed. */
  ambientAuth?: boolean
  /** Skills to install natively under `<configHome>/skills/<name>/`. */
  skills?: SkillSpec[]
  /** Tool servers to scope to this job's config. */
  mcpServers?: McpServerSpec[]
  /** Job-scoped child env (tester secrets, a private-registry npmrc pointer). */
  extraEnv?: Record<string, string>
  log?: Logger
}

/**
 * Write a repo-sourced skill as a NATIVE Claude Code skill under `<skillsRoot>/<name>/`: a
 * `SKILL.md` (YAML frontmatter `name`/`description` + the instructions body, the format the CLI
 * expects) plus every resource file at its path within the skill directory. Resource sub-paths
 * were sanitized at the job boundary (no traversal), so nested dirs are created as needed.
 *
 * The frontmatter `name`/`description` values are emitted as JSON-encoded (double-quoted) YAML
 * scalars, not bare plain scalars: an author's description routinely contains `: ` (colon-space)
 * or a leading YAML indicator (`#`, `-`, `[`, `{`, `"`, …), which is invalid as a plain scalar and
 * would make the CLI fail to parse the frontmatter and silently skip the skill. A JSON string is a
 * valid YAML double-quoted scalar, so quoting makes the manifest robust to arbitrary text.
 */
async function writeNativeSkill(skillsRoot: string, skill: SkillSpec): Promise<void> {
  const dir = join(skillsRoot, skill.name)
  await mkdir(dir, { recursive: true })
  const name = JSON.stringify(skill.name)
  const description = JSON.stringify(skill.description.replace(/\r?\n/g, ' '))
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n`
  await writeFile(join(dir, 'SKILL.md'), `${frontmatter}\n${skill.instructions}\n`, 'utf8')
  for (const resource of skill.resources) {
    const dest = join(dir, resource.relPath)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, resource.content, 'utf8')
  }
}

/**
 * Prepare the Claude Code CLI's MCP wiring for one run: write the servers to a PER-RUN config and
 * return the argv that points the CLI at it, plus the cleanup for a directory we had to mint.
 *
 * Two decisions live here. `--strict-mcp-config` makes that file the ONLY source of servers, so an
 * ambient run on a developer's own machine can never silently hand the agent their personal ones.
 * And `--allowedTools` is passed ONLY when a server actually narrows its tools — an allow-list is
 * whole-session, not MCP-scoped, so it carries `builtIns`, the SAME list this run declared with
 * `--tools`, in the same entry; see `claudeAllowedToolPatterns` for why that list is threaded in
 * rather than re-derived, and how the run's permission mode treats an allow-list.
 *
 * The config carries this job's resolved credentials, so it goes in the isolated config home when
 * we own one and a throwaway per-JOB directory otherwise — never the checkout (it would land in a
 * commit) and never a shared HOME path (a concurrent job would clobber it).
 */
async function setUpClaudeMcp(
  servers: McpServerSpec[] | undefined,
  configHome: string | undefined,
  builtIns: readonly string[],
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const noop = { args: [], cleanup: async () => {} }
  if (!servers?.length) return noop
  // Before anything can spawn: a failing MCP server echoes its own argv/headers into stderr, and
  // that tail is carried onto the step's diagnostics.
  registerKnownSecrets(mcpServerSecretValues(servers))
  const home = configHome ?? (await mkdtemp(join(tmpdir(), 'cf-claude-mcp-')))
  const owned = home === configHome ? undefined : home
  const cleanup = async (): Promise<void> => {
    if (owned) await rm(owned, { recursive: true, force: true }).catch(() => {})
  }
  const configPath = await writeClaudeMcpConfig(home, servers)
  if (!configPath) return { args: [], cleanup }
  const allowedTools = claudeAllowedToolPatterns(servers, builtIns)
  return {
    args: [
      '--mcp-config',
      configPath,
      '--strict-mcp-config',
      ...(allowedTools?.length ? ['--allowedTools', allowedTools.join(',')] : []),
    ],
    cleanup,
  }
}

/**
 * The isolated, per-run home the `claude` CLI runs against: a temp config dir OUTSIDE the cloned
 * checkout, pre-seeded past the first-launch prompts, carrying the run's native skills and MCP
 * config, plus the child env pointing the CLI at it. {@link ClaudeRunHome.dispose} is the other
 * half of the same concern — the leased credential must never outlive the run — so acquisition
 * and teardown are defined together rather than split across a `finally` forty lines away.
 *
 * Ambient (native) mode has NO home: the developer's installed CLI uses its own `~/.claude`
 * login, so nothing is created, nothing is pre-seeded, and `dispose` only clears the MCP config.
 */
export interface ClaudeRunHome {
  /** The per-run config dir; `undefined` in ambient mode (the developer's own login is used). */
  configHome: string | undefined
  /** The CLI argv selecting the run's tool servers; empty when it has none. */
  mcpArgs: string[]
  /** The child-process env (see {@link buildClaudeEnv}). */
  env: Record<string, string>
  dispose: () => Promise<void>
}

export async function openClaudeRunHome(
  opts: ClaudeHomeOptions,
  tools: readonly string[],
): Promise<ClaudeRunHome> {
  // Native (ambient) mode: run the developer's installed `claude` with its OWN login —
  // no isolated config home, no injected credential, no onboarding pre-seed. Otherwise,
  // Claude Code persists user config/credentials under its config dir; point that at an
  // isolated, per-run temp dir OUTSIDE the cloned checkout (`opts.cwd`). Otherwise the
  // agents that finish with `git add -A` (blueprint/requirements/bootstrap) could stage a
  // stray `.claude/` directory — and any cached credential in it — into the pushed branch.
  // Mirrors the Codex CODEX_HOME isolation (`codex-home.ts`); removed by `dispose`.
  if (!opts.ambientAuth && !opts.subscriptionToken) {
    throw new Error('claude-code harness requires a subscription token (or ambientAuth)')
  }
  const configHome = opts.ambientAuth ? undefined : await mkdtemp(join(tmpdir(), 'cf-claude-'))

  // The config dir is brand-new every run, so Claude Code would otherwise treat this
  // as a first launch and BLOCK on the interactive onboarding / "trust this folder" /
  // bypass-permissions acknowledgement prompts — which never get answered headlessly,
  // hanging the job until the watchdog kills it. Pre-seed the config that marks those
  // as already accepted so `-p` starts straight into the run. Best-effort: written
  // before the CLI starts; unknown keys are harmless if a CLI version ignores them.
  // (Ambient mode skips this — the developer's own config is already onboarded.)
  // ADR 0026 D4: assert the pinned onboarding keys landed and log them with the CLI
  // version, so a future first-run gate this set doesn't cover (which looks identical to
  // a healthy-but-quiet subagent start) is diffable when the cold-start watchdog fires.
  if (configHome) {
    await writeOnboardingPreseed(configHome)
    await assertOnboardingKeysCurrent(configHome, process.env.CLAUDE_CLI_VERSION, opts.log)
  }

  // Skills: install each as a native skill under the config dir's `skills/<name>/` so the CLI
  // discovers and can invoke it. ONLY into the isolated per-run config home — never the
  // developer's own `~/.claude` (ambient/native mode), where it would persist in their personal
  // setup after the run and two concurrent jobs carrying same-named skills would clobber each
  // other. An ambient run reads the skills from the checkout instead (`.cat-context/skill/<name>/`,
  // materialised by the caller). Best-effort: a write failure must not wedge the run — the prompt
  // still names the skills.
  if (configHome) {
    for (const skill of opts.skills ?? []) {
      await writeNativeSkill(join(configHome, 'skills'), skill).catch(() => {})
    }
  }

  // Tool servers (MCP): the CLI is pointed at a per-run config rather than discovering an ambient
  // one. See `setUpClaudeMcp` for why that matters and what has to be cleaned up afterwards.
  const mcp = await setUpClaudeMcp(opts.mcpServers, configHome, tools)

  return {
    configHome,
    mcpArgs: mcp.args,
    env: buildClaudeEnv(opts, configHome),
    dispose: async () => {
      // The ambient-mode MCP config dir (credential-bearing) never outlives the run.
      await mcp.cleanup()
      if (!configHome) return
      // Lift the CLI session transcripts (`projects/`) out for short-lived retention BEFORE the
      // home is deleted — the credential lives at the home root, never in `projects/`, so this
      // keeps the debugging artifact without leaking the token. Best-effort; never throws.
      await retainSessionTranscripts(configHome, ['projects'], {
        label: 'claude-code',
        ...(opts.log ? { log: opts.log } : {}),
      })
      // Never leave the config dir (and any cached credential) on disk past the run.
      await rm(configHome, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/**
 * Build the child-process env for the `claude` CLI: an isolated config home plus subscription
 * auth (Anthropic OAuth token, or an Anthropic-compatible base URL + auth token for a
 * non-Anthropic Claude-Code vendor like GLM/Kimi/DeepSeek), or an empty env in ambient mode
 * (the developer's own logged-in `~/.claude` is used). Extracted from {@link runClaudeCode} to
 * keep its cyclomatic complexity down; behaviour is a straight move of the original expression.
 */
function buildClaudeEnv(
  opts: ClaudeHomeOptions,
  configHome: string | undefined,
): Record<string, string> {
  // The job-scoped env rides along in BOTH modes; the credential/config vars below are what
  // ambient mode drops (the developer's own logged-in `~/.claude` is used instead).
  if (opts.ambientAuth) return { ...opts.extraEnv }
  return {
    ...opts.extraEnv,
    CLAUDE_CONFIG_DIR: configHome!,
    ...(opts.subscriptionBaseUrl
      ? {
          ANTHROPIC_BASE_URL: opts.subscriptionBaseUrl,
          ANTHROPIC_AUTH_TOKEN: opts.subscriptionToken!,
        }
      : { CLAUDE_CODE_OAUTH_TOKEN: opts.subscriptionToken! }),
  }
}
