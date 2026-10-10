import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { CustomTaskType } from '@cat-factory/kernel'
import {
  TOOL_SERVER_BUDGET,
  createRecordingLogger,
  defaultGateRegistry,
  defaultPromptFragmentRegistry,
  defaultTaskTypeRegistry,
} from '@cat-factory/kernel'
import {
  REGISTRATION_WARN_CODES,
  collectRegistrationProblems,
  logRegistrationWarning,
} from './validation/validateRegistrations.js'
import type { RegistrationWarning } from './validation/validateRegistrations.js'

// ---------------------------------------------------------------------------
// The WARN half of boot validation, as a contract rather than as one more case per check
// (ADR 0063). Three things are asserted here that no individual check's test can see:
//
//  - every warn code names a `subject`, and it is the id its own MESSAGE names;
//  - a defect is reported ONCE, whatever number of kinds or mentions it arrives through;
//  - `logRegistrationWarning`, the sink all three facades pass, actually emits `subject`.
//
// The first is graded against `REGISTRATION_WARN_CODES` rather than against whatever the fixture
// happens to produce, which is the whole reason that list is closed: a code no fixture provokes
// contributes zero rows to a filter and passes it in silence, which is how the first version of
// this assertion covered six of the nine and provoked the one violating code with a fixture whose
// credential key and envName were the same string.
// ---------------------------------------------------------------------------

const TASK_TYPE_BASE = {
  taskType: 'org:introduce-api',
  presentation: {
    label: 'Introduce API',
    icon: 'i-lucide-plug',
    color: '#0ea5e9',
    description: 'Expose functionality over HTTP.',
  },
} satisfies Partial<CustomTaskType>

/** A task type with one unresolvable standard: the only warn an agent registry cannot raise. */
const TASK_TYPE_WITH_UNKNOWN_FRAGMENT: CustomTaskType = {
  ...TASK_TYPE_BASE,
  defaultFragmentIds: ['org.api-guidelins'],
}

/**
 * A registry misconfigured on purpose, wide enough to provoke every warn code the agent-capability
 * checks can raise. Each kind carries ONE fault, so a message that names the wrong registration
 * shows up as a mismatch rather than being masked by a neighbour that happens to share an id.
 */
function misconfiguredKinds(): AgentKindRegistry {
  const registry = defaultAgentKindRegistry()
  // `skills_without_container` + `tool_servers_without_container`: an inline kind can wire neither.
  registry.register({
    kind: 'inline-auditor',
    systemPrompt: 'audit',
    agent: { surface: 'inline' },
    skills: [{ catalogSkillId: 'src:acme:house-style' }],
    toolServers: [{ id: 'issues', transport: { kind: 'stdio', command: 'x' } }],
  })
  // `postops_without_structured_output`: hooks that will read `result.custom` and find nothing.
  registry.register({
    kind: 'render-only',
    systemPrompt: 'x',
    agent: { surface: 'container-explore', clone: { branch: 'pr' } },
    postOps: [async () => {}],
  })
  // `too_many_tool_servers` + `tool_servers_over_byte_budget`: past both dimensions at once, which
  // is the realistic accretion case and keeps the two codes on one kind.
  registry.register({
    kind: 'over-budget',
    systemPrompt: 'x',
    agent: { surface: 'container-explore' },
    toolServers: Array.from({ length: TOOL_SERVER_BUDGET.maxServers + 1 }, (_, i) => ({
      id: `srv${i}`,
      transport: { kind: 'stdio' as const, command: 'x', env: { BLOB: 'x'.repeat(4_000) } },
    })),
  })
  // The three DEFINITION-scoped warns, one server each.
  registry.register({
    kind: 'explorer',
    systemPrompt: 'explore',
    agent: { surface: 'container-explore' },
    toolServers: [
      // No harness serves http-over-codex, so the declaration never applies to any run.
      {
        id: 'stdio-only',
        transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
        harnesses: ['codex'],
      },
      // The granted OAuth token wins the header, so the static credential reaches nothing.
      {
        id: 'docs',
        transport: { kind: 'http', url: 'https://docs.example.com/mcp' },
        oauth: { grant: 'authorization_code', clientId: 'cid' },
        secretKeys: [{ key: 'ACME_DOCS_KEY', header: 'authorization' }],
      },
      // An http value is sent as a header, so the injection name is read by nobody. The key and the
      // envName are deliberately DIFFERENT strings: while they were one, a message naming only the
      // envName satisfied the subject relation below by coincidence.
      {
        id: 'search',
        transport: { kind: 'http', url: 'https://search.example.com/mcp' },
        secretKeys: [{ key: 'ACME_SEARCH_KEY', envName: 'MCP_SEARCH_TOKEN', header: 'x-api-key' }],
      },
    ],
  })
  return registry
}

/** Every boot problem one agent registry plus one task type raises. */
function problemsFrom(
  agentKindRegistry: AgentKindRegistry,
  taskType: CustomTaskType = TASK_TYPE_WITH_UNKNOWN_FRAGMENT,
) {
  const taskTypeRegistry = defaultTaskTypeRegistry()
  taskTypeRegistry.register(taskType)
  return collectRegistrationProblems({
    registries: {
      agentKindRegistry,
      gateRegistry: defaultGateRegistry(),
      taskTypeRegistry,
      promptFragmentRegistry: defaultPromptFragmentRegistry(),
    },
  })
}

function warningsFrom(agentKindRegistry: AgentKindRegistry): RegistrationWarning[] {
  return problemsFrom(agentKindRegistry).flatMap((problem) =>
    problem.severity === 'warn' ? [problem] : [],
  )
}

describe('registration warnings', () => {
  it('provokes EVERY declared warn code, so the contract below covers all of them', () => {
    // Derived from the code list the validator itself is typed against, not from a count: a count
    // fails on every ordinary addition and says nothing about what broke, while this fails with
    // the name of the code nothing exercised.
    const raised = new Set(warningsFrom(misconfiguredKinds()).map((w) => w.code))
    expect(REGISTRATION_WARN_CODES.filter((code) => !raised.has(code))).toEqual([])
  })

  it('names a SUBJECT on every warning, and names that subject in the message too', () => {
    // The half of the contract no type can state. `subject` being required makes a subject-less
    // warning unconstructible and being singular makes a batch unrepresentable, but nothing says
    // the id it carries is the id the prose points at. A warning whose message names one
    // registration while its subject names another is worse than no subject: a deployment's
    // predicate escalates the wrong one, silently.
    const offenders = warningsFrom(misconfiguredKinds())
      .filter((w) => w.subject.trim() === '' || !w.message.includes(w.subject))
      .map((w) => ({ code: w.code, subject: w.subject, message: w.message }))
    expect(offenders).toEqual([])
  })

  it('reports a SHARED tool server once, naming every kind it is declared for', () => {
    // A registered server attached to three kinds is ONE registration and one edit. Reported per
    // kind, the same defect arrived three times under the same `subject`, so a deployment
    // escalating by subject saw one fault as three and the boot failure counted mentions.
    const registry = defaultAgentKindRegistry()
    registry.registerToolServer({
      id: 'shared-docs',
      transport: { kind: 'http', url: 'https://docs.example.com/mcp' },
      harnesses: ['codex'],
    })
    for (const kind of ['coder', 'ci-fixer', 'merger']) {
      registry.assignToolServers(kind, ['shared-docs'])
    }
    const unservable = warningsFrom(registry).filter((w) => w.code === 'tool_server_unservable')
    expect(unservable.map((w) => w.subject)).toEqual(['shared-docs'])
    // Every kind named, because the blast radius is what the reader acts on: a server one kind
    // declares is fixed on that kind, and a shared one attached to three is a wider fault than a
    // message naming the first of them would read as.
    for (const kind of ['coder', 'ci-fixer', 'merger']) {
      expect(unservable[0]?.message).toContain(`"${kind}"`)
    }
  })

  it('reports a repeated fragment id ONCE, so a shared standard is not several defects', () => {
    // The escalation unit is the id, and naming one standard in several conditional rules is
    // ordinary authoring: the checker receives every rule's ids as one flattened list. Reported per
    // MENTION, the deployment's predicate ran once per mention and the boot failure counted
    // mentions rather than defects.
    const problems = problemsFrom(defaultAgentKindRegistry(), {
      ...TASK_TYPE_BASE,
      fields: [{ key: 'protocol', label: 'Protocol', type: 'text' }],
      defaultFragmentIds: ['org.dupe', 'org.dupe'],
      conditionalFragmentIds: [
        { when: { key: 'protocol', equals: 'graphql' }, fragmentIds: ['org.shared'] },
        { when: { key: 'protocol', equals: 'rest' }, fragmentIds: ['org.shared'] },
      ],
    })
    expect(problems.map((p) => (p.severity === 'warn' ? p.subject : p.code))).toEqual([
      'org.dupe',
      'org.shared',
    ])
  })

  it('fails boot on a BLANK fragment id rather than warning with nothing to name', () => {
    // The one unresolved id boot CAN judge: no tier resolves a blank id, so the account/workspace
    // cause that keeps this class soft cannot apply. It is also the only shape that could have
    // produced a warning with an empty `subject`, which is a predicate handed nothing to test.
    const problems = problemsFrom(defaultAgentKindRegistry(), {
      ...TASK_TYPE_BASE,
      defaultFragmentIds: [''],
    })
    expect(problems.map((p) => [p.severity, p.code])).toEqual([
      ['error', 'task_type_blank_fragment_id'],
    ])
  })

  it('gives two servers that share a credential KEY distinct subjects', () => {
    // A credential key is a store lookup name several servers may legitimately share, so as a
    // subject it made two separate defects indistinguishable by the one field a predicate reads.
    // What has to change is each server's own `secretKeys` entry, so the server is the subject and
    // the key is named in the message.
    const registry = defaultAgentKindRegistry()
    const withSharedKey = (id: string) => ({
      id,
      transport: { kind: 'http' as const, url: `https://${id}.example.com/mcp` },
      secretKeys: [{ key: 'ACME_SHARED_KEY', envName: 'MCP_TOKEN', header: 'x-api-key' }],
    })
    registry.register({
      kind: 'explorer',
      systemPrompt: 'explore',
      agent: { surface: 'container-explore' },
      toolServers: [withSharedKey('docs-a'), withSharedKey('docs-b')],
    })
    const warnings = warningsFrom(registry).filter((w) => w.code === 'unused_credential_env_name')
    expect(warnings.map((w) => w.subject)).toEqual(['docs-a', 'docs-b'])
    for (const warning of warnings) expect(warning.message).toContain('ACME_SHARED_KEY')
  })

  it('logs the subject as a FIELD through the sink every facade passes', () => {
    // `logRegistrationWarning` exists because three hand-copied arrows had already drifted, one
    // facade logging the coarser line. Its whole product is what lands in those fields, so a
    // regression to `logger.warn({ code }, message)` or a dropped `subject` would otherwise pass
    // every test in this file.
    const logger = createRecordingLogger()
    const warning = warningsFrom(misconfiguredKinds()).find(
      (w) => w.code === 'task_type_unknown_fragment',
    )
    logRegistrationWarning(logger)(warning as RegistrationWarning)
    expect(logger.lines).toEqual([
      {
        level: 'warn',
        msg: warning?.message,
        fields: { code: 'task_type_unknown_fragment', subject: 'org.api-guidelins' },
      },
    ])
  })
})
