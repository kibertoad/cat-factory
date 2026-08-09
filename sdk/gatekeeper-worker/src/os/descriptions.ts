// What the OS is told about a call, derived from the operation table rather than authored.
//
// The bindings already carry every fact an approver needs: what the operation does, the route it
// is, the scope floor behind it, whether it mutates, whether the platform annotated it as
// destructive, and whether it reads captured telemetry. Deriving the descriptions from those is
// the same no-drift rule the table itself exists for: a hand-written description per operation
// would be forty strings that stop matching the surface the day an operation changes, and the
// place the staleness lands is an approval prompt, which is the worst possible place for it.
//
// The description is MARKDOWN rendered to a human, and the argument bag inside it is agent-authored
// text. So arguments go inside a fence sized one tick longer than the longest backtick run in the
// body, which is this repo's own rule for captured output reaching a rendered surface: a fixed
// ``` fence closes on the first ``` inside the payload and spills the rest, plus everything after
// it, into what the approver reads as the platform's own prose.

import { resolveConsequence, type GatekeeperBinding } from '@cat-factory/gatekeeper-bindings'
import type { ActionDescription, ActionKind, ObservationDescription } from './protocol.js'

/** Who a described call is made as, for the approver reading it. */
export interface CallSubject {
  /** The account this session was opened for. */
  accountId: string
  /** The policy tier that account resolved to. */
  tier: string
  /** The paired deployment the call lands on. */
  deployment: string
}

/**
 * Fence a payload so it cannot break out of the code block that holds it.
 *
 * Sized one backtick longer than the longest run the payload contains, which is what makes it
 * total: a payload holding ```` closes a ``` fence and everything after it, including the rest of
 * this description, renders as prose the approver reads as ours.
 */
function fenced(payload: string): string {
  const longestRun = [...payload.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  )
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}json\n${payload}\n${fence}`
}

/** The arguments as an approver should see them: the bag that will actually be forwarded. */
function renderArguments(args: Record<string, unknown>): string {
  const keys = Object.keys(args)
  if (keys.length === 0) return 'This call carries no arguments.'
  let payload: string
  try {
    payload = JSON.stringify(args, null, 2) ?? String(args)
  } catch {
    // A cycle or a value JSON cannot carry. The call would fail downstream anyway, and an
    // approver told nothing about the arguments is being asked to approve an unknown.
    payload = '"<arguments could not be rendered>"'
  }
  return fenced(payload)
}

/** The route line both description kinds open their detail with. */
function routeLine(binding: GatekeeperBinding): string {
  return `\`${binding.httpMethod} ${binding.path}\` on ${'`'}${binding.operationId}${'`'}`
}

/**
 * Describe a read.
 *
 * `prohibitAllSharing` is set for exactly the operations the table marks as reading a telemetry
 * sink, which are the ones that serve CAPTURED TEXT: model prompts and replies, tool arguments,
 * agent search terms, provisioning output. Every one of those sits inside a `read` key's floor, so
 * without this the platform's most sensitive reads would be shared onward on the same terms as a
 * task list. The annotation already exists for the policy layer; this is the second consumer it
 * was always going to have.
 */
export function describeObservation(
  binding: GatekeeperBinding,
  args: Record<string, unknown>,
  subject: CallSubject,
): ObservationDescription {
  const captured =
    binding.telemetrySink !== undefined
      ? `\n\nThis read serves CAPTURED TEXT from the \`${binding.telemetrySink}\` telemetry sink: ` +
        'model prompts and replies, tool arguments, or agent search terms. It is withheld from ' +
        'sharing for that reason.'
      : ''
  return {
    title: `${binding.summary} (${subject.deployment})`,
    description:
      `Read ${routeLine(binding)} on the cat-factory deployment at ${subject.deployment}, as ` +
      `account \`${subject.accountId}\` at policy tier \`${subject.tier}\`.\n\n` +
      `${renderArguments(args)}${captured}`,
    ...(binding.telemetrySink !== undefined ? { prohibitAllSharing: true } : {}),
  }
}

/** The stable tag an OS pre-approval rule matches this operation by. */
export function actionKindOf(binding: GatekeeperBinding): ActionKind {
  return { tag: binding.name, label: binding.summary }
}

/**
 * Describe a side effect.
 *
 * Three fields are fixed for every action this Gatekeeper submits, and each is a statement about
 * what this implementation does rather than a default:
 *
 *   - `implementsRevert: false`. Reverting a started run, a merged pull request or a stopped job is
 *     not something this Worker can do on the caller's behalf, and the flag exists precisely so the
 *     UI does not offer an undo that would not work.
 *   - `awaitDecision: true`. This Gatekeeper does not SIMULATE: there is no provisional run id to
 *     hand an agent so it can keep working while a human decides. The spec's alternative for a
 *     non-simulating gatekeeper is to suspend the agent's turn, which is what the flag asks for.
 *   - `autoApprovable` follows the table's own consequence reading, with the cautious default
 *     applied by `resolveConsequence`: an unannotated mutation is destructive, so it is NOT
 *     offered for auto-approval. Being auto-approvable is still only permission for a user who
 *     opted into this action's kind; it never approves anything by itself.
 */
export function describeAction(
  binding: GatekeeperBinding,
  args: Record<string, unknown>,
  subject: CallSubject,
): ActionDescription {
  const consequence = resolveConsequence(binding)
  const stakes = consequence.destructive
    ? 'This operation is annotated DESTRUCTIVE: its effects are not safely repeatable, and this ' +
      'Gatekeeper cannot revert it.'
    : 'This operation is annotated non-destructive' +
      (consequence.idempotent ? ' and idempotent.' : '.')
  return {
    title: `${binding.summary} (${subject.deployment})`,
    description:
      `Call ${routeLine(binding)} on the cat-factory deployment at ${subject.deployment}, as ` +
      `account \`${subject.accountId}\` at policy tier \`${subject.tier}\`. The call is made with ` +
      `a per-account API key at scope \`${binding.minScope}\` or above, minted for and stamped ` +
      'with that account.\n\n' +
      `${renderArguments(args)}\n\n${stakes}`,
    implementsRevert: false,
    awaitDecision: true,
    autoApprovable: !consequence.destructive,
    actionKind: actionKindOf(binding),
  }
}
