import { describe, expect, it } from 'vitest'
import {
  assertClaudeToolsCurrent,
  claudeCliArgs,
  CLAUDE_TOOL_CAPABILITIES,
  CLAUDE_TOOL_SET,
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
    claudeCliArgs({ model: 'sonnet', tools, declareTools: true, mcpArgs: [], appendArgs: [] })

  it('declares the tool set rather than taking the CLI’s headless default', () => {
    const argv = args(CLAUDE_TOOL_SET)
    const at = argv.indexOf('--tools')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe(CLAUDE_TOOL_SET.join(','))
  })

  it('withholds the flag entirely when the CLI is not this image’s', () => {
    // An ambient run drives the developer's own `claude`, of unknown version. A tool NAME it does
    // not carry is dropped silently, which is what makes the set safe to over-include; an
    // unrecognised FLAG exits before the run starts, so the whole declaration is withheld rather
    // than trimmed. Nothing else about the argv changes.
    const declared = args(CLAUDE_TOOL_SET)
    const ambient = claudeCliArgs({
      model: 'sonnet',
      tools: CLAUDE_TOOL_SET,
      declareTools: false,
      mcpArgs: [],
      appendArgs: [],
    })
    expect(ambient).not.toContain('--tools')
    expect(ambient).not.toContain(CLAUDE_TOOL_SET.join(','))
    expect(ambient).toEqual(
      declared.filter((a) => a !== '--tools' && a !== CLAUDE_TOOL_SET.join(',')),
    )
  })

  it('keeps every variadic flag terminated by a following flag, never a positional', () => {
    // `--tools` and `--allowedTools` are both `<tools...>`, so each swallows a trailing POSITIONAL
    // as another tool name. The prompt rides stdin for exactly this reason; what this pins is that
    // nothing in the argv itself sits bare after one of them.
    const argv = claudeCliArgs({
      model: 'sonnet',
      tools: CLAUDE_TOOL_SET,
      declareTools: true,
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
    const argv = args(CLAUDE_TOOL_SET)
    expect(argv.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
    expect(argv).toContain('bypassPermissions')
  })
})

describe('CLAUDE_TOOL_SET', () => {
  it('is the ONE list the allow-list re-grant is built from, so the two cannot drift', () => {
    // Derived from the same source the code reads rather than restated: the allow-list is
    // ADDITIVE, so a second, independently-written list would silently unlock what `--tools`
    // withheld on exactly the runs that wire a narrowing tool server.
    const patterns = claudeAllowedToolPatterns(
      [{ id: 'issues', transport: 'stdio', command: 'npx', allowedTools: ['search'] }],
      CLAUDE_TOOL_SET,
    )
    expect(patterns).toEqual(['mcp__issues__search', ...CLAUDE_TOOL_SET])
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

  it('asks for everything the CLI’s headless default carries that a container can use', () => {
    // A declaration is measured against the DEFAULT it replaces, not only against what the issue
    // asked for: a name the default carried, this container can act on, and the list omits is a
    // capability the declaration silently took away. Measured off CLI 2.1.246's own `init` event;
    // the rest of that default (`CronCreate`, `DesignSync`, `SendMessage`, `Workflow`, …) is
    // deliberately absent because a per-run container can act on none of it.
    for (const fromDefault of ['Bash', 'Edit', 'Monitor', 'Read', 'Skill', 'Write']) {
      expect(CLAUDE_TOOL_SET).toContain(fromDefault)
    }
  })

  it('keeps a retired spelling beside the successor it aliases onto', () => {
    // Measured against 2.1.246, each probed ALONE so the grant is attributable: `--tools
    // BashOutput` grants `TaskOutput`, `KillBash` and `KillShell` both grant `TaskStop`, and
    // `Agent` grants `Task`. A retired name in this category is not a hole, it is how an OLDER
    // pinned CLI is asked for the same capability, so dropping it would cost that capability
    // there while looking like tidying here.
    for (const [retired, successor] of [
      ['BashOutput', 'TaskOutput'],
      ['KillBash', 'TaskStop'],
      ['KillShell', 'TaskStop'],
      ['Agent', 'Task'],
    ]) {
      expect(CLAUDE_TOOL_SET).toContain(retired)
      expect(CLAUDE_TOOL_SET).toContain(successor)
    }
  })

  it('carries the CURRENT spelling of a name the CLI dropped without aliasing', () => {
    // The other category, and the one that actually cost a capability. Measured alone against
    // 2.1.246, `ListMcpResources` and `ReadMcpResource` are dropped rather than aliased onto the
    // `*Tool` spellings the CLI now serves, so a list carrying only the old pair reached its
    // tool servers' resources through nothing at all. An old spelling may be kept for an older
    // pinned CLI, but never INSTEAD of the current one.
    for (const [dropped, current] of [
      ['ListMcpResources', 'ListMcpResourcesTool'],
      ['ReadMcpResource', 'ReadMcpResourceTool'],
    ]) {
      expect(CLAUDE_TOOL_SET).toContain(dropped)
      expect(CLAUDE_TOOL_SET).toContain(current)
    }
  })

  it('declares the vendor-served web tools unconditionally', () => {
    // They are served by the vendor the leased subscription already pays, not by our web-search
    // proxy, so no deployment wiring decides whether they work. Gating them on the proxy's
    // availability withheld a WORKING capability on the strength of an unrelated fact; the flag
    // that would legitimately withhold them is a per-run web-access policy this platform does not
    // have. If one is ever added, this assertion is the one that should fail first.
    expect(CLAUDE_TOOL_SET).toContain('WebSearch')
    expect(CLAUDE_TOOL_SET).toContain('WebFetch')
  })

  it('names each tool exactly once', () => {
    expect(new Set(CLAUDE_TOOL_SET).size).toBe(CLAUDE_TOOL_SET.length)
  })
})

describe('assertClaudeToolsCurrent', () => {
  it('warns and names the CLI version when a required capability was granted no tool', () => {
    const { log, warns, infos } = recordingLogger()
    // A CLI that renamed `Grep` away: everything else the floor needs is present.
    const granted = satisfyingGrant().filter((t) => t !== 'Grep')
    assertClaudeToolsCurrent(initEvent(granted, '2.1.245'), CLAUDE_TOOL_SET, log)
    expect(infos).toHaveLength(0)
    expect(warns).toHaveLength(1)
    const fields = warns[0]![1] as Record<string, unknown>
    expect(fields.missingCapabilities).toEqual(['search'])
    expect(fields.cliVersion).toBe('2.1.245')
    expect(fields.grantedTools).toEqual([...granted].sort())
  })

  it('does not warn for a fully satisfied request', () => {
    const { log, warns, infos } = recordingLogger()
    assertClaudeToolsCurrent(initEvent(satisfyingGrant()), CLAUDE_TOOL_SET, log)
    expect(warns).toHaveLength(0)
    expect(infos).toHaveLength(1)
  })

  it('does not warn for a requested tool the CLI simply does not have', () => {
    // The request is over-inclusive ON PURPOSE so one image faces several CLI versions. Warning
    // on every alternate spelling would fire on every run, which is a warning nobody reads.
    const { log, warns } = recordingLogger()
    assertClaudeToolsCurrent(initEvent(satisfyingGrant()), CLAUDE_TOOL_SET, log)
    expect(warns).toHaveLength(0)
  })

  it('accepts an alternate spelling of a capability', () => {
    // `Task` and `Agent` are the same capability under two CLI vocabularies; either satisfies it.
    const { log, warns } = recordingLogger()
    const granted = satisfyingGrant().map((t) => (t === 'Task' ? 'Agent' : t))
    assertClaudeToolsCurrent(initEvent(granted), CLAUDE_TOOL_SET, log)
    expect(warns).toHaveLength(0)
  })

  it('says the surface is UNVERIFIED when the CLI announced no tool list', () => {
    // Absent and empty are different facts: a CLI that named no tools tells us nothing about what
    // it granted, and silence there would read exactly like a satisfied request.
    const { log, warns, infos } = recordingLogger()
    assertClaudeToolsCurrent(initEvent(undefined), CLAUDE_TOOL_SET, log)
    expect(infos).toHaveLength(0)
    expect(warns).toHaveLength(1)
    expect(String(warns[0]![0])).toContain('unverified')
  })

  it('ignores every event that is not the CLI’s startup report', () => {
    const { log, warns, infos } = recordingLogger()
    assertClaudeToolsCurrent({ type: 'assistant' }, CLAUDE_TOOL_SET, log)
    assertClaudeToolsCurrent({ type: 'system', subtype: 'commands_changed' }, [], log)
    expect(warns).toHaveLength(0)
    expect(infos).toHaveLength(0)
  })
})
