import { beforeEach, describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import type { CustomTaskType } from '@cat-factory/kernel'
import type {
  DescriptorField,
  InitiativePresetDescriptor,
  InitiativePresetField,
} from '@cat-factory/contracts'
import {
  InitiativePresetRegistry,
  defaultGateRegistry,
  defaultPromptFragmentRegistry,
  defaultTaskTypeRegistry,
} from '@cat-factory/kernel'
import type { PromptFragmentRegistry } from '@cat-factory/kernel'
import {
  collectRegistrationProblems,
  validateRegistrations,
} from './validation/validateRegistrations.js'

// Boot validation of the three DESCRIPTOR-shaped registrations: a deployment's best-practice
// prompt fragments, the custom task types that select them (a REUSABLE OPERATION's bundle), and
// the initiative presets that declare a form over the same field vocabulary.
//
// Split out of `extension-registries.test.ts` when the conditional-standing-context checks pushed
// that file over its line budget. A cohesive seam rather than an arbitrary cut: these three are
// the ones whose subject is a DECLARED FORM or the standing context a form's answers select, and
// they share `descriptorFormProblems` as their checker.

describe('deployment-registered prompt fragments', () => {
  const collect = (fragments: Parameters<PromptFragmentRegistry['register']>[0][]) => {
    const promptFragmentRegistry = defaultPromptFragmentRegistry()
    for (const f of fragments) promptFragmentRegistry.register(f)
    return collectRegistrationProblems({
      registries: {
        agentKindRegistry: defaultAgentKindRegistry(),
        gateRegistry: defaultGateRegistry(),
        promptFragmentRegistry,
      },
    })
  }
  const inline = {
    id: 'org.api-guidelines',
    version: '1.0.0',
    title: 'Org API guidelines',
    category: 'Org',
    summary: 'How this org shapes APIs.',
    body: 'Plural nouns.',
  }

  it('accepts a fragment whose body is registered inline', () => {
    expect(collect([inline])).toEqual([])
  })

  it('REFUSES a code-registered documentRef, which is carried, rendered live, and never resolved', () => {
    // The dead seam: `builtinToEntry` carries the ref into the resolved entry, `entryToFragment`
    // puts it on the wire, the library UI renders a "live from <source>" badge naming it, and
    // `resolveDocumentBody` then short-circuits on `entry.tier === 'builtin'`. Every code
    // registration lands on that tier, so the reference is preserved everywhere it is visible and
    // honoured nowhere, and the surface most confident about it is the one telling a human the
    // body is live.
    //
    // An ERROR rather than a warning because there is no deployment state in which it starts
    // resolving, and what it produces is a lie rather than an omission.
    const problems = collect([
      { ...inline, documentRef: { source: 'github' as const, externalId: 'org/repo:g.md' } },
    ])
    expect(problems.map((p) => p.code)).toEqual(['fragment_document_ref_unsupported'])
    expect(problems[0]?.severity).toBe('error')
    // The message names the two paths that DO work, because "this is refused" without them just
    // moves the dead end.
    expect(problems[0]?.message).toContain('inline')
    expect(problems[0]?.message).toContain('ACCOUNT tier')
  })
})

/** The presentation half every custom-task-type case below shares, spread over its own fields. */
const TASK_TYPE_BASE = {
  presentation: {
    label: 'Introduce API',
    icon: 'i-lucide-plug',
    color: '#0ea5e9',
    description: 'Expose functionality over HTTP.',
  },
}

/**
 * Boot problems for ONE registered custom task type. Module-scope because the two describes below
 * split its reference-resolution half from its form half and must ask the same question of the same
 * wiring; the fragment pool is a parameter because only the first of them registers fragments.
 */
const taskTypeProblems = (
  taskType: CustomTaskType,
  promptFragmentRegistry = defaultPromptFragmentRegistry(),
) => {
  const taskTypeRegistry = defaultTaskTypeRegistry()
  taskTypeRegistry.register(taskType)
  return collectRegistrationProblems({
    registries: {
      agentKindRegistry: defaultAgentKindRegistry(),
      gateRegistry: defaultGateRegistry(),
      taskTypeRegistry,
      promptFragmentRegistry,
    },
  })
}

describe('custom task types (reusable operations)', () => {
  const base = TASK_TYPE_BASE
  // A FRESH fragment registry per call, so a fragment one case registers cannot leak into another.
  // That used to need an `afterEach` clearing a module global; an injected instance simply cannot
  // outlive its test.
  let promptFragmentRegistry = defaultPromptFragmentRegistry()
  beforeEach(() => {
    promptFragmentRegistry = defaultPromptFragmentRegistry()
  })
  /** A minimal valid fragment, for the pool-resolution assertions below. */
  const fragment = (id: string) => ({
    id,
    version: '1.0.0',
    title: id,
    category: 'Org',
    summary: `The ${id} standard.`,
    body: 'BODY',
  })
  const problemsFor = (taskType: CustomTaskType) =>
    taskTypeProblems(taskType, promptFragmentRegistry)

  it('resolves defaultFragmentIds against the code pool without complaint', () => {
    promptFragmentRegistry.register({
      id: 'org.api-guidelines',
      version: '1.0.0',
      title: 'Org API guidelines',
      category: 'Org',
      summary: 'How this org shapes APIs.',
      body: 'Plural nouns.',
    })
    expect(
      problemsFor({
        ...base,
        taskType: 'org:introduce-api',
        defaultFragmentIds: ['org.api-guidelines'],
      }),
    ).toEqual([])
  })

  it('seeds CONDITIONAL fragments only when their condition holds against the collected values', () => {
    // An operation that collects `protocol` in the same form cannot otherwise say "and when it is
    // graphql, also seed the GraphQL standard": it must seed the union on every run, or fold the
    // conditional guidance into one long standard and lose the per-standard citation the
    // reviewers' adherence report is built on.
    promptFragmentRegistry.register(fragment('org.graphql'))
    expect(
      problemsFor({
        ...base,
        taskType: 'org:introduce-api',
        fields: [
          {
            key: 'protocol',
            label: 'Protocol',
            type: 'select',
            options: [
              { value: 'rest', label: 'REST' },
              { value: 'graphql', label: 'GraphQL' },
            ],
          },
        ],
        conditionalFragmentIds: [
          { when: { key: 'protocol', equals: 'graphql' }, fragmentIds: ['org.graphql'] },
        ],
      }),
    ).toEqual([])
  })

  it('fails boot on a conditional gated on a field the type does not declare', () => {
    // The same class as `showWhen` on an undeclared field, and for the same reason: every input is
    // known from the registration, the condition can never hold, and the only symptom is guidance
    // that silently never seeds.
    const problems = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      fields: [{ key: 'protocol', label: 'Protocol', type: 'text' }],
      conditionalFragmentIds: [
        { when: { key: 'protocl', equals: 'graphql' }, fragmentIds: ['org.graphql'] },
      ],
    })
    expect(problems.map((p) => p.code)).toContain('task_type_field_unknown_condition')
    expect(problems[0]?.message).toContain('protocl')
  })

  it('holds a conditional fragment id to the same WARN as an unconditional one', () => {
    // Not an error, for the reason the unconditional check states: an account/workspace-tier id
    // merges per workspace at run time and is invisible at boot, so refusing here would reject
    // the tenant-tier reference deployments are told to use.
    const problems = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      fields: [{ key: 'protocol', label: 'Protocol', type: 'text' }],
      conditionalFragmentIds: [
        { when: { key: 'protocol', equals: 'graphql' }, fragmentIds: ['org.graphq'] },
      ],
    })
    expect(problems.map((p) => p.severity)).toEqual(['warn'])
    expect(problems[0]?.code).toBe('task_type_unknown_fragment')
  })

  it('names the DECLARATION the unresolvable ids came from, not always defaultFragmentIds', () => {
    // The conditional check reuses the unconditional checker, which used to hardcode
    // `defaultFragmentIds` into its message. An operator then greps their registration for an id
    // that is not there, concludes the warning is stale, and moves on.
    const problems = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      fields: [{ key: 'protocol', label: 'Protocol', type: 'text' }],
      conditionalFragmentIds: [
        { when: { key: 'protocol', equals: 'graphql' }, fragmentIds: ['org.graphq'] },
      ],
    })
    expect(problems[0]?.message).toContain('conditionalFragmentIds')
    expect(problems[0]?.message).not.toContain('defaultFragmentIds "org.graphq"')
  })

  it('fails boot on a conditional whose condition states no predicate at all', () => {
    // `equals` and `includes` are both optional on the schema, so a dropped `equals: "graphql"`
    // still validates, and the shared evaluator reads a predicate-less condition as SATISFIED
    // (right for field visibility, where the alternative hides a field forever). Left alone, every
    // REST case is silently seeded with the GraphQL standard: the misseeding conditional fragments
    // exist to remove.
    const problems = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      fields: [{ key: 'protocol', label: 'Protocol', type: 'text' }],
      conditionalFragmentIds: [{ when: { key: 'protocol' }, fragmentIds: ['org.graphql'] }],
    })
    expect(problems[0]?.severity).toBe('error')
    expect(problems[0]?.code).toBe('task_type_conditional_no_predicate')
  })

  it('lets a formPanel type gate conditionals, having no descriptor fields to declare them in', () => {
    // A bespoke panel collects its bag through its own component, so `fields` is legitimately
    // empty and there is nothing to check a `when.key` against. Refusing was refusing BOOT for the
    // one shape the feature exists to support.
    promptFragmentRegistry.register(fragment('org.graphql'))
    expect(
      problemsFor({
        ...base,
        taskType: 'org:introduce-api',
        formPanel: 'org:introduce-api-form',
        conditionalFragmentIds: [
          { when: { key: 'protocol', equals: 'graphql' }, fragmentIds: ['org.graphql'] },
        ],
      }),
    ).toEqual([])
  })

  it('checks NOTHING against a pool this process cannot see', () => {
    // A mothership-mode node: the registry holds the shipped catalog, and the deployment's
    // standards live on the MOTHERSHIP, which is the only place they take effect. Judging ids
    // against the local registry would warn about every org standard at every boot for a
    // configuration that resolves perfectly at run time.
    const taskTypeRegistry = defaultTaskTypeRegistry()
    taskTypeRegistry.register({
      ...base,
      taskType: 'org:introduce-api',
      defaultFragmentIds: ['org.api-guidelines'],
    })
    const registries = {
      agentKindRegistry: defaultAgentKindRegistry(),
      gateRegistry: defaultGateRegistry(),
      taskTypeRegistry,
      promptFragmentRegistry,
    }
    // In-process (the ordinary deployment): the id is checked, and warned about.
    expect(
      collectRegistrationProblems({
        registries: {
          ...registries,
          promptFragments: {
            inProcess: true,
            all: async () => [],
            defaultFragmentIdsFor: async () => [],
          },
        },
      }).map((p) => p.code),
    ).toEqual(['task_type_unknown_fragment'])
    // Remote: silent, because there is no local pool that speaks for the run's.
    expect(
      collectRegistrationProblems({
        registries: {
          ...registries,
          promptFragments: {
            inProcess: false,
            all: async () => [],
            defaultFragmentIdsFor: async () => [],
          },
        },
      }),
    ).toEqual([])
  })

  it('WARNS on an unresolvable fragment id, naming both causes it cannot tell apart', () => {
    // A workspace/account-tier fragment merges per workspace at RUN time, so boot structurally
    // cannot see one: refusing would reject a legitimate tenant-tier reference, and staying
    // silent leaves a typo'd id folding nothing for the life of the deployment.
    const problems = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      defaultFragmentIds: ['org.api-guidelnes'],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.severity).toBe('warn')
    expect(problems[0]?.code).toBe('task_type_unknown_fragment')
    expect(problems[0]?.message).toContain('org.api-guidelnes')
    expect(problems[0]?.message).toContain('account/workspace-tier')
    // A warn never aborts boot; it is reported through `onWarn`.
    const warned: string[] = []
    const taskTypeRegistry = defaultTaskTypeRegistry()
    taskTypeRegistry.register({
      ...base,
      taskType: 'org:introduce-api',
      defaultFragmentIds: ['org.api-guidelnes'],
    })
    expect(() =>
      validateRegistrations({
        registries: {
          agentKindRegistry: defaultAgentKindRegistry(),
          gateRegistry: defaultGateRegistry(),
          taskTypeRegistry,
          // Passed deliberately: with no registry there is no pool, and the id checks stand down
          // rather than reporting every id as unresolvable against an empty set.
          promptFragmentRegistry,
        },
        onWarn: (p) => warned.push(p.code),
      }),
    ).not.toThrow()
    expect(warned).toContain('task_type_unknown_fragment')
  })

  it('still ERRORS on a defaultPipelineId that resolves to nothing', () => {
    // The pipeline reference is a different bar from the fragment one: an unknown id means the
    // created task silently falls back to the workspace's positional default pipeline, and
    // nothing at run time can tell that apart from a deliberate choice.
    const problems = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      defaultPipelineId: 'pl_nope',
    })
    expect(problems[0]?.severity).toBe('error')
    expect(problems[0]?.code).toBe('task_type_unknown_pipeline')
  })
})

// The FORM half of a custom task type's registration, split from the reference-resolution half above
// when the two together pushed one describe past its function-length budget. A cohesive cut rather
// than an arbitrary one: every test above asks whether the ids a registration NAMES resolve, and
// every test here asks whether the form it DECLARES can be filled and rendered.
describe('custom task type create forms', () => {
  const base = TASK_TYPE_BASE
  // No fragment pool: nothing here NAMES a fragment, so each call gets a fresh empty one.
  const problemsFor = (taskType: CustomTaskType) => taskTypeProblems(taskType)
  it('ERRORS on a create form that structurally cannot be filled', () => {
    // The three ways the richer field vocabulary lets a descriptor break itself, each of which
    // fails silently in the form rather than anywhere a test or a user could name.
    const optionless = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      fields: [{ key: 'style', label: 'Style', type: 'select' }],
    })
    expect(optionless[0]?.severity).toBe('error')
    expect(optionless[0]?.code).toBe('task_type_field_no_options')

    const danglingCondition = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      fields: [
        {
          key: 'verb',
          label: 'Verb',
          type: 'text',
          showWhen: { key: 'resourceStyle', equals: 'a' },
        },
      ],
    })
    expect(danglingCondition[0]?.code).toBe('task_type_field_unknown_condition')

    const duplicate = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      fields: [
        { key: 'entity', label: 'Entity', type: 'text' },
        { key: 'entity', label: 'Entity again', type: 'textarea' },
      ],
    })
    expect(duplicate[0]?.code).toBe('task_type_field_duplicate')

    // A DEFAULT outside the field's own options. Latent while defaults were seeded only by the
    // form (an odd opening value); an ERROR now that the creation door applies them, because every
    // creation of the type is refused for a value the caller never sent.
    const strayDefault = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      fields: [
        {
          key: 'style',
          label: 'Style',
          type: 'select',
          default: 'rpc',
          options: [{ value: 'action', label: 'Action' }],
        },
      ],
    })
    expect(strayDefault[0]?.severity).toBe('error')
    expect(strayDefault[0]?.code).toBe('task_type_field_default_outside_options')

    const strayGroupDefault = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      fields: [
        {
          key: 'ops',
          label: 'Operations',
          type: 'checkbox-group',
          defaultValues: ['create', 'purge'],
          options: [{ value: 'create', label: 'Create' }],
        },
      ],
    })
    expect(strayGroupDefault[0]?.code).toBe('task_type_field_default_outside_options')

    // A well-formed form, including a condition on a field it does declare, is silent.
    expect(
      problemsFor({
        ...base,
        taskType: 'org:introduce-api',
        fields: [
          {
            key: 'style',
            label: 'Style',
            type: 'select',
            default: 'action',
            options: [{ value: 'action', label: 'Action' }],
          },
          {
            key: 'verb',
            label: 'Verb',
            type: 'text',
            showWhen: { key: 'style', equals: 'action' },
          },
        ],
      }),
    ).toEqual([])
  })

  it('ERRORS on a section declared in two places, and accepts a grouped form', () => {
    // Grouping is presentation, and this is still an error, because neither rendering is honest: the
    // renderer preserves declaration order, so the caption appears TWICE (reading as a platform
    // fault rather than as the declaration it is), and merging the two runs would move a field away
    // from where its author wrote it. Knowable from the registration, so boot is where it can be
    // fixed. Folded on case and spacing, exactly as the renderer cuts the runs, so a case-variant
    // re-declaration cannot pass as a distinct section.
    const interleaved = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      fields: [
        { key: 'style', label: 'Style', type: 'text', section: 'Shape' },
        { key: 'dir', label: 'Directory', type: 'path', section: 'Placement' },
        { key: 'verb', label: 'Verb', type: 'text', section: 'shape' },
      ],
    })
    expect(interleaved[0]?.severity).toBe('error')
    expect(interleaved[0]?.code).toBe('task_type_field_section_interleaved')
    // Named by the spelling the form would render, not the one that broke it.
    expect(interleaved[0]?.message).toContain('"Shape"')

    expect(
      problemsFor({
        ...base,
        taskType: 'org:introduce-api',
        fields: [
          { key: 'entity', label: 'Entity', type: 'text' },
          { key: 'style', label: 'Style', type: 'text', section: 'Shape' },
          { key: 'verb', label: 'Verb', type: 'text', section: 'Shape' },
          { key: 'dir', label: 'Directory', type: 'path', section: 'Placement' },
        ],
      }),
    ).toEqual([])
  })

  it('does NOT refuse a section interleaved only with a mutually exclusive branch', () => {
    // The refusal is about what a form can be made to PRINT, not about the order of the declared
    // list, because the renderer applies `showWhen` before it cuts the runs. A branching form is
    // written exactly this way (each branch's fields beside the picker they qualify), so reading
    // contiguity off the flat list would fail boot outright over a form no user can break.
    expect(
      problemsFor({
        ...base,
        taskType: 'org:introduce-api',
        fields: [
          {
            key: 'kind',
            label: 'Kind',
            type: 'select',
            options: [
              { value: 'http', label: 'HTTP' },
              { value: 'cli', label: 'CLI' },
            ],
          },
          {
            key: 'method',
            label: 'Method',
            type: 'text',
            section: 'Endpoint',
            showWhen: { key: 'kind', equals: 'http' },
          },
          {
            key: 'argv',
            label: 'Argv',
            type: 'text',
            section: 'Command',
            showWhen: { key: 'kind', equals: 'cli' },
          },
          {
            key: 'timeout',
            label: 'Timeout',
            type: 'number',
            section: 'Endpoint',
            showWhen: { key: 'kind', equals: 'http' },
          },
        ],
      }),
    ).toEqual([])
  })
})

describe('initiative presets: the OTHER descriptor-driven form', () => {
  // Both surfaces declare their form over one vocabulary (`contracts/src/form-fields.ts`), so both
  // break the same three ways and both are held to the same bar by the SAME checker. Without this,
  // the fillability check would cover whichever surface happened to get it first.
  const descriptorFor = (fields: InitiativePresetField[]): InitiativePresetDescriptor => ({
    id: 'preset_org_audit',
    presentation: {
      label: 'Org audit',
      icon: 'i-lucide-search-check',
      color: '#6366f1',
      description: 'Audit the estate against the org standards.',
    },
    fields,
    planningPipelineId: 'pl_initiative',
    interview: 'skip',
    humanReviewDefault: true,
    defaultFragmentIds: [],
  })

  const problemsFor = (fields: InitiativePresetField[]) => {
    const initiativePresetRegistry = new InitiativePresetRegistry()
    initiativePresetRegistry.register({ descriptor: descriptorFor(fields) })
    return collectRegistrationProblems({
      registries: {
        agentKindRegistry: defaultAgentKindRegistry(),
        gateRegistry: defaultGateRegistry(),
        initiativePresetRegistry,
      },
    }).filter((problem) => problem.code.startsWith('initiative_preset_'))
  }

  it('ERRORS on a preset create form that structurally cannot be filled', () => {
    const optionless = problemsFor([{ key: 'style', label: 'Style', type: 'select' }])
    expect(optionless[0]?.severity).toBe('error')
    expect(optionless[0]?.code).toBe('initiative_preset_field_no_options')
    expect(optionless[0]?.message).toContain('preset_org_audit')

    expect(
      problemsFor([
        { key: 'verb', label: 'Verb', type: 'text', showWhen: { key: 'nope', equals: 'a' } },
      ])[0]?.code,
    ).toBe('initiative_preset_field_unknown_condition')

    expect(
      problemsFor([
        { key: 'root', label: 'Root', type: 'path' },
        { key: 'root', label: 'Root again', type: 'text' },
      ])[0]?.code,
    ).toBe('initiative_preset_field_duplicate')

    // The grouping fault reaches this surface through the same checker, so a preset cannot declare a
    // section the create modal would caption twice.
    expect(
      problemsFor([
        { key: 'scope', label: 'Scope', type: 'text', section: 'Scope' },
        { key: 'root', label: 'Root', type: 'path' },
        { key: 'depth', label: 'Depth', type: 'number', section: 'Scope' },
      ])[0]?.code,
    ).toBe('initiative_preset_field_section_interleaved')
  })

  it('is silent on a well-formed form, and on the built-in presets that ride along', () => {
    // `all()` includes the baked-in generic preset, so an empty registry still gets checked: the
    // shipped descriptors are registrations like any other and are not exempted.
    expect(
      problemsFor([
        { key: 'style', label: 'Style', type: 'select', options: [{ value: 'a', label: 'A' }] },
        { key: 'verb', label: 'Verb', type: 'text', showWhen: { key: 'style', equals: 'a' } },
      ]),
    ).toEqual([])
    expect(
      collectRegistrationProblems({
        registries: {
          agentKindRegistry: defaultAgentKindRegistry(),
          gateRegistry: defaultGateRegistry(),
          initiativePresetRegistry: new InitiativePresetRegistry(),
        },
      }).filter((problem) => problem.code.startsWith('initiative_preset_')),
    ).toEqual([])
  })
})

// The THIRD surface that declares a descriptor form, and the one that reads least like one: a gate
// declares its per-step parameters as an OPTION on `GateRegistry.register`, so nothing at the call
// site says "descriptor form". It renders through the same `DescriptorFields` component the other two
// do, and so it fails the same ways, which is why it is held to the same bar by the same checker
// rather than by a copy or by nothing.
describe('gate config forms: the third descriptor-driven form', () => {
  const problemsFor = (configFields: DescriptorField[]) => {
    const gateRegistry = defaultGateRegistry()
    gateRegistry.register(
      'license-check',
      () => ({
        kind: 'license-check',
        helperKind: 'ci-fixer',
        wired: () => true,
        unwiredOutput: 'skipped',
        probe: async () => ({ status: 'pass', headSha: null }),
        onExhausted: async () => ({ error: 'spent' }),
      }),
      { configFields },
    )
    return collectRegistrationProblems({
      registries: { agentKindRegistry: defaultAgentKindRegistry(), gateRegistry },
    }).filter((problem) => problem.code.startsWith('gate_field_'))
  }

  it('ERRORS on each way a gate form cannot be filled, naming the gate', () => {
    const duplicate = problemsFor([
      { key: 'minScore', label: 'Minimum score', type: 'number' },
      { key: 'minScore', label: 'Minimum score again', type: 'text' },
    ])
    expect(duplicate.map((p) => p.code)).toEqual(['gate_field_duplicate'])
    expect(duplicate[0]?.severity).toBe('error')
    // Named by the REGISTRATION, because that is the only place it can be fixed: the pipeline author
    // who meets the broken form did not write it and cannot repair it.
    expect(duplicate[0]?.message).toContain('license-check')

    expect(
      problemsFor([{ key: 'tier', label: 'Tier', type: 'select' }]).map((p) => p.code),
    ).toEqual(['gate_field_no_options'])
    expect(
      problemsFor([
        { key: 'strict', label: 'Strict', type: 'text', showWhen: { key: 'nope', equals: 'a' } },
      ]).map((p) => p.code),
    ).toEqual(['gate_field_unknown_condition'])
    expect(
      problemsFor([
        {
          key: 'tier',
          label: 'Tier',
          type: 'select',
          default: 'gold',
          options: [{ value: 'bronze', label: 'Bronze' }],
        },
      ]).map((p) => p.code),
    ).toEqual(['gate_field_default_outside_options'])
  })

  it('ERRORS on a section its config form would caption twice', () => {
    // The gap this suite was added for. Gate config forms gained `section` for free by riding the
    // shared vocabulary, and rendered it through the shared component, with no check behind it: a
    // gate could boot clean and print the exact duplicate caption the platform calls its own fault.
    expect(
      problemsFor([
        { key: 'minScore', label: 'Minimum score', type: 'number', section: 'Thresholds' },
        { key: 'notify', label: 'Notify', type: 'checkbox' },
        { key: 'maxScore', label: 'Maximum score', type: 'number', section: 'thresholds' },
      ]).map((p) => p.code),
    ).toEqual(['gate_field_section_interleaved'])
  })

  it('is silent on a well-formed form, and on a gate that declares none', () => {
    expect(
      problemsFor([
        { key: 'minScore', label: 'Minimum score', type: 'number', section: 'Thresholds' },
        { key: 'maxScore', label: 'Maximum score', type: 'number', section: 'Thresholds' },
        { key: 'notify', label: 'Notify', type: 'checkbox' },
      ]),
    ).toEqual([])
    // A gate declaring no fields is not a subject here rather than a subject with an empty form.
    expect(problemsFor([])).toEqual([])
  })
})
