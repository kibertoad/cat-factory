import { describe, expect, it } from 'vitest'
import {
  assertClaudeToolsCurrent,
  claudeCliArgs,
  claudeRequestedTools,
  CLAUDE_TOOL_CAPABILITIES,
  CLAUDE_TOOL_SET,
  CLAUDE_WEB_TOOLS,
} from '../src/claude-cli.js'
import { claudeAllowedToolPatterns } from '../src/agent-capabilities.js'
import type { Logger } from '../src/logger.js'

// The declared tool surface: what the CLI is asked for, and the read-back that says what it gave.

function recordingLogger(): { log: Logger; warns: unknown[][]; infos: unknown[][] } {
  const warns: unknown[][] = []
  const infos: unknown[][] = []
  const log = {
    info: (...a: unknown[]) => infos.push(a),
    warn: (...a: unknown[]) => warns.push(a),
    error: () => {},
    debug: () => {},
    child: () => log,
  } as unknown as Logger
  return { log, warns, infos }
}

const initEvent = (tools: unknown, version = '2.1.245'): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  claude_code_version: version,
  tools,
})

/** A grant that satisfies every capability in the floor, using each entry's first spelling. */
const satisfyingGrant = (): string[] => CLAUDE_TOOL_CAPABILITIES.map((c) => c.spellings[0]!)

describe('claudeCliArgs', () => {
  const args = (tools: readonly string[]) =>
    claudeCliArgs({ model: 'sonnet', tools, mcpArgs: [], appendArgs: [] })

  it('declares the run’s tool set rather than taking the CLI’s headless default', () => {
    const argv = args(claudeRequestedTools(true))
    const at = argv.indexOf('--tools')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe(CLAUDE_TOOL_SET.join(','))
  })

  it('keeps every variadic flag terminated by a following flag, never a positional', () => {
    // `--tools` and `--allowedTools` are both `<tools...>`, so each swallows a trailing POSITIONAL
    // as another tool name. The prompt rides stdin for exactly this reason; what this pins is that
    // nothing in the argv itself sits bare after one of them.
    const argv = claudeCliArgs({
      model: 'sonnet',
      tools: claudeRequestedTools(true),
      mcpArgs: ['--mcp-config', '/tmp/mcp.json', '--strict-mcp-config', '--allowedTools', 'a,b'],
      appendArgs: ['--append-system-prompt', 'be brief'],
    })
    for (const variadic of ['--tools', '--allowedTools']) {
      const value = argv.indexOf(variadic) + 1
      // The flag's own value, then the next entry: it must open a new flag (or end the argv).
      const next = argv[value + 1]
      expect(next === undefined || next.startsWith('--')).toBe(true)
    }
  })

  it('carries the checked-in invocation contract the stream reader depends on', () => {
    const argv = args(claudeRequestedTools(false))
    expect(argv.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
    expect(argv).toContain('bypassPermissions')
  })
})

describe('claudeRequestedTools', () => {
  it('declares the web tools only when the deployment serves web research', () => {
    const withWeb = claudeRequestedTools(true)
    const withoutWeb = claudeRequestedTools(false)
    for (const tool of CLAUDE_WEB_TOOLS) {
      expect(withWeb).toContain(tool)
      expect(withoutWeb).not.toContain(tool)
    }
    // Nothing ELSE moves with that switch: the two lists differ by the web tools alone.
    expect(withWeb.filter((t) => !CLAUDE_WEB_TOOLS.includes(t))).toEqual([...withoutWeb])
  })

  it('is the ONE list the allow-list re-grant is built from, so the two cannot drift', () => {
    // Derived from the same source the code reads rather than restated: the allow-list is
    // ADDITIVE, so a second, independently-written list would silently unlock what `--tools`
    // withheld on exactly the runs that wire a narrowing tool server.
    const tools = claudeRequestedTools(false)
    const patterns = claudeAllowedToolPatterns(
      [{ id: 'issues', transport: 'stdio', command: 'npx', allowedTools: ['search'] }],
      tools,
    )
    expect(patterns).toEqual(['mcp__issues__search', ...tools])
  })

  it('asks for every spelling the capability floor accepts', () => {
    // The floor may only name tools this harness actually requests; a floor entry the request
    // does not carry could never be granted, so it would warn on every run forever.
    for (const capability of CLAUDE_TOOL_CAPABILITIES) {
      for (const spelling of capability.spellings) {
        expect(CLAUDE_TOOL_SET).toContain(spelling)
      }
    }
  })
})

describe('assertClaudeToolsCurrent', () => {
  it('warns and names the CLI version when a required capability was granted no tool', () => {
    const { log, warns, infos } = recordingLogger()
    // A CLI that renamed `Grep` away: everything else the floor needs is present.
    const granted = satisfyingGrant().filter((t) => t !== 'Grep')
    assertClaudeToolsCurrent(initEvent(granted, '2.1.245'), claudeRequestedTools(true), log)
    expect(infos).toHaveLength(0)
    expect(warns).toHaveLength(1)
    const fields = warns[0]![1] as Record<string, unknown>
    expect(fields.missingCapabilities).toEqual(['search'])
    expect(fields.cliVersion).toBe('2.1.245')
    expect(fields.grantedTools).toEqual([...granted].sort())
  })

  it('does not warn for a fully satisfied request', () => {
    const { log, warns, infos } = recordingLogger()
    assertClaudeToolsCurrent(initEvent(satisfyingGrant()), claudeRequestedTools(true), log)
    expect(warns).toHaveLength(0)
    expect(infos).toHaveLength(1)
  })

  it('does not warn for a requested tool the CLI simply does not have', () => {
    // The request is over-inclusive ON PURPOSE so one image faces several CLI versions. Warning
    // on every alternate spelling would fire on every run, which is a warning nobody reads.
    const { log, warns } = recordingLogger()
    assertClaudeToolsCurrent(initEvent(satisfyingGrant()), claudeRequestedTools(true), log)
    expect(warns).toHaveLength(0)
  })

  it('accepts an alternate spelling of a capability', () => {
    // `Task` and `Agent` are the same capability under two CLI vocabularies; either satisfies it.
    const { log, warns } = recordingLogger()
    const granted = satisfyingGrant().map((t) => (t === 'Task' ? 'Agent' : t))
    assertClaudeToolsCurrent(initEvent(granted), claudeRequestedTools(true), log)
    expect(warns).toHaveLength(0)
  })

  it('says the surface is UNVERIFIED when the CLI announced no tool list', () => {
    // Absent and empty are different facts: a CLI that named no tools tells us nothing about what
    // it granted, and silence there would read exactly like a satisfied request.
    const { log, warns, infos } = recordingLogger()
    assertClaudeToolsCurrent(initEvent(undefined), claudeRequestedTools(true), log)
    expect(infos).toHaveLength(0)
    expect(warns).toHaveLength(1)
    expect(String(warns[0]![0])).toContain('unverified')
  })

  it('ignores every event that is not the CLI’s startup report', () => {
    const { log, warns, infos } = recordingLogger()
    assertClaudeToolsCurrent({ type: 'assistant' }, claudeRequestedTools(true), log)
    assertClaudeToolsCurrent({ type: 'system', subtype: 'commands_changed' }, [], log)
    expect(warns).toHaveLength(0)
    expect(infos).toHaveLength(0)
  })
})
