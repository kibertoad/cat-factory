import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { defaultGateRegistry } from '@cat-factory/kernel'
import { collectRegistrationProblems } from '@cat-factory/orchestration'
import { describe, expect, it } from 'vitest'
import { binaryGeneratorRegistryWithBuiltins } from './index.js'

// ---------------------------------------------------------------------------
// The shipped set, run through the REAL boot validator.
//
// `defineBinaryGenerator` applies the same rules at import, so this looks redundant and is not:
// the authoring seam calls the rule sets a definition can fail on its own, while
// `collectRegistrationProblems` is the whole boot pass, including the checks that span definitions
// and any check a future release adds to the section. If the two ever disagree the boot is right,
// and this test is what says so before a deployment upgrades into it.
//
// Asserted as a DIFFERENCE against the same registries with no integrations rather than as an
// empty list, because the baseline is not this package's to control: it is whatever the platform's
// own agent-kind and gate defaults produce, and pinning it here would fail on an unrelated change
// while naming nothing about generators.
// ---------------------------------------------------------------------------

const baseRegistries = () => ({
  agentKindRegistry: defaultAgentKindRegistry(),
  gateRegistry: defaultGateRegistry(),
})

describe('the shipped integrations', () => {
  it('add no registration problem to a deployment’s boot', () => {
    const withoutGenerators = collectRegistrationProblems({ registries: baseRegistries() })
    const withGenerators = collectRegistrationProblems({
      registries: {
        ...baseRegistries(),
        binaryGeneratorRegistry: binaryGeneratorRegistryWithBuiltins(),
      },
    })
    expect(withGenerators).toEqual(withoutGenerators)
  })
})
