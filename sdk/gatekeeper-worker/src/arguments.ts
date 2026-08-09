// Checking a call's arguments against what the operation DECLARES, before anything happens.
//
// The published contract asks a gatekeeper to validate RPC arguments against the declared
// signature and reject a call carrying one the receiver does not declare. The reference
// implementations generate that check from their own signatures; ours is generated already, one
// layer down: every binding in `@cat-factory/gatekeeper-bindings` carries its path parameters, its
// query parameters with which are required, and whether it takes a body. So the check is derived
// from the same table the session's `.d.ts` and the policy compiler read, and an operation whose
// shape changes brings its own validation with it.
//
// The reason to have it at all is the SILENT DROP. `invoke` forwards the arguments it recognises
// and ignores the rest, so an agent asking `tasks_list_by_service` to filter by a parameter that
// operation does not take used to get an unfiltered list and no word about it: a wrong answer
// shaped exactly like a right one. A near-miss spelling is the same failure with a plainer cause.
//
// It runs on BOTH doors, ahead of the approval queue and ahead of the key broker. That order is
// the point: a call that cannot succeed should not mint a credential, should not spend a
// workspace's approval on an action that would 400, and should not reach the deployment at all.
// Refusing it is a behaviour change for a caller that was sending an argument nothing read, which
// is exactly the caller this check exists for.
//
// What it does NOT check is what a value may BE. That is the deployment's judgement, it is stated
// in the spec these bindings are generated from, and its refusal already names the field; a second
// copy of it here would be free to disagree with the first.

import type { GatekeeperBinding } from '@cat-factory/gatekeeper-bindings'
import { GatekeeperError } from './errors.js'

/** The one argument key that is never a parameter: the request body `invoke` forwards. */
const BODY = 'body'

/**
 * Every argument name an operation reads, in the order a caller would learn them.
 *
 * Exported because `approvals_inspect` and the session types describe the same set from the same
 * binding, and a second derivation of "what may I pass" is how a published shape and an enforced
 * one drift.
 */
export function declaredArguments(binding: GatekeeperBinding): string[] {
  return [
    ...binding.pathParams,
    ...binding.queryParams.map((param) => param.name),
    ...(binding.hasBody ? [BODY] : []),
  ]
}

/**
 * Refuse a call whose arguments the operation does not declare, or that omits one it requires.
 *
 * Returns the bag so the call site reads as a narrowing rather than as a statement with a side
 * effect. An `undefined` value is treated as absent throughout, which is what a caller building a
 * bag from optional fields produces and what the SDK's own forwarding already does with it.
 */
export function checkedArguments(
  binding: GatekeeperBinding,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const declared = declaredArguments(binding)
  const supplied = Object.entries(args).filter(([, value]) => value !== undefined)

  const undeclared = supplied.map(([name]) => name).filter((name) => !declared.includes(name))
  if (undeclared.length > 0) {
    throw new GatekeeperError(
      'undeclared_argument',
      `'${binding.name}' does not take ${quoted(undeclared)}, so ${undeclared.length === 1 ? 'it would be' : 'they would be'} ` +
        `dropped rather than sent. It takes ${declared.length === 0 ? 'no arguments' : quoted(declared)}.`,
    )
  }

  for (const name of binding.pathParams) {
    const value = args[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new GatekeeperError(
        'missing_argument',
        `'${binding.name}' needs '${name}': it is part of the route (\`${binding.path}\`), so ` +
          'there is no call to make without it.',
      )
    }
  }

  for (const param of binding.queryParams) {
    if (param.required && args[param.name] === undefined) {
      throw new GatekeeperError(
        'missing_argument',
        `'${binding.name}' needs '${param.name}': the deployment refuses the call without it, ` +
          'because it says which question is being asked rather than narrowing the answer.',
      )
    }
  }

  return args
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `'${name}'`).join(', ')
}
