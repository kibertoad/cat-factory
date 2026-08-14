import type { BinaryGeneratorRegistry } from '@cat-factory/kernel'
import {
  binaryGeneratorDetailIssues,
  binaryGeneratorInjectionCollisions,
} from '@cat-factory/kernel'
import {
  type BinaryGeneratorDefinition,
  binaryGeneratorDefinitionIssues,
} from '@cat-factory/contracts'
// Type-only, so the pairing with the module this section was extracted from stays a compile-time
// fact and no import cycle exists at runtime.
import type { RegistrationProblem } from './validateRegistrations.js'

/**
 * Section 9 of `collectRegistrationProblems`: every generative binary integration a deployment
 * registers must be a definition the platform can actually dispatch against.
 *
 * Its own module rather than more of `validateRegistrations.ts` because the section is a cohesive
 * concern with a growing rule set, and its host had reached the file-size ratchet.
 *
 * Boot is the only place these can be caught for a deployment that registers in its own code.
 * There is no write boundary that ever refused them, and every failure below is silent at run time
 * in the same expensive way: a malformed definition or an unparseable contract becomes an
 * integration the brief describes with no operations, a credential key that is not a valid
 * environment-variable name is dropped by the harness's env validation and reappears as an
 * unexplained 401 mid-run, and a cleartext endpoint puts that credential on the wire from inside
 * the run container. Each of those costs a run to discover and names nothing that points back at
 * the registration.
 *
 * The RULES are kernel's (`binaryGeneratorDetailIssues` / `binaryGeneratorInjectionCollisions`),
 * not this module's, and that split is what makes them reusable: a definitions package
 * (`@cat-factory/binary-generators`, and a deployment's own) runs the same functions at authoring
 * time, so a definition that would fail this boot fails a test first. What stays here is the boot
 * TAXONOMY: which severity each fault carries, and that a definition failing its parse is not
 * asked the questions the parse just called meaningless.
 */
export function checkBinaryGenerators(
  registry: BinaryGeneratorRegistry | undefined,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  if (!registry) return problems
  const valid: BinaryGeneratorDefinition[] = []
  for (const definition of registry.all()) {
    const issues = binaryGeneratorDefinitionIssues(definition)
    if (issues.length > 0) {
      problems.push({
        severity: 'error',
        code: 'binary_generator_invalid',
        message: `Generative binary integration "${definition.id}" is not a valid definition: ${issues.join('; ')}`,
      })
      // The checks below read fields this parse just called malformed, so reporting them too
      // would restate one fault as several.
      continue
    }
    valid.push(definition)
    problems.push(...asProblems(binaryGeneratorDetailIssues(definition)))
  }
  // Only definitions that PARSED are compared: a malformed one has already been reported, and
  // reading its credentials here would restate that fault as a second, more confusing one.
  problems.push(...asProblems(binaryGeneratorInjectionCollisions(valid)))
  return problems
}

/**
 * Every rule in that module is an ERROR at boot, and each of them says why in its own doc: the
 * deployment either starts having disabled an integration it paid for, or starts with a credential
 * on a cleartext wire. A warning would be a line an operator reads once per boot and stops seeing,
 * for faults whose remedy is one edit in the deployment's own code.
 */
function asProblems(issues: readonly { code: string; message: string }[]): RegistrationProblem[] {
  return issues.map((issue) => ({ severity: 'error', code: issue.code, message: issue.message }))
}
