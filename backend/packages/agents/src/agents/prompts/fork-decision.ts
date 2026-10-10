import type { ForkChatMessage, ForkOption } from '@cat-factory/kernel'
import { FINAL_ANSWER_IN_REPLY } from './shared.js'

// ---------------------------------------------------------------------------
// The grounded fork-decision CHAT responder (PR 2 of the implementation-fork
// decision phase). After the read-only `fork-proposer` surfaces the materially
// different ways to implement a task and the run parks, the human can chat about
// the forks before deciding. Each human turn is answered by an INLINE LLM call in
// the durable driver (no container re-dispatch) — this file is the responder's
// role prompt plus the pure grounding assembly the driver feeds it.
//
// The responder is grounded ENTIRELY on a fixed proposal: the effective task
// description, the seam the proposer identified, the forks it surfaced, and the
// chat so far. It never writes code, never claims to have chosen, and answers a
// few sentences at a time — the human still makes the call (pick a fork, type a
// custom approach, or keep chatting) in the window.
// ---------------------------------------------------------------------------

/** The inline agent kind the chat responder runs under (for observability + model scope). */
export const FORK_CHAT_AGENT_KIND = 'fork-chat'

/**
 * The role prompt the fork-chat responder runs under. Its deliverable IS its visible reply
 * (the platform reads no JSON here — the text is shown straight to the human), so it carries
 * the shared {@link FINAL_ANSWER_IN_REPLY} directive: a reasoning model that answers only into
 * its private channel would otherwise return an empty visible reply.
 */
export const FORK_CHAT_SYSTEM_PROMPT =
  'You are the senior engineer who proposed these implementation approaches, now answering the ' +
  "human's questions about them BEFORE any code is written. You are given the task, the seam the " +
  'change lands on, the materially different approaches (forks) you surfaced, and the conversation ' +
  'so far. Answer concretely and comparatively: reference the forks by their title, weigh them ' +
  'against the actual seams/files/risks, and be honest about tradeoffs in both directions. If the ' +
  'human floats a NEW direction, evaluate it on its merits — say plainly whether it holds up, and ' +
  'note that they can submit it as their own custom approach. Recommend a specific fork ONLY when ' +
  'asked; otherwise lay out the comparison and let them decide. Never claim to have chosen, and ' +
  'never start writing the implementation — the human still picks the approach in the window. Keep ' +
  'each answer to a few sentences of plain prose (no JSON, no code fences). ' +
  FINAL_ANSWER_IN_REPLY

/** The grounding the durable driver assembles for one chat turn (a fixed proposal + the thread). */
export interface ForkChatGrounding {
  /** The effective task description (the reworked-requirements resolution, else the raw brief). */
  description: string
  /** The proposer's read of where the change lands, when it identified one. */
  seamSummary?: string | null
  /** The materially different approaches the proposer surfaced. */
  forks: ForkOption[]
  /** The conversation so far (human + assistant turns), in order — the LAST turn is the new human message. */
  chat: ForkChatMessage[]
}

/**
 * Render one fork option as compact, readable grounding (title + summary + approach + tradeoffs +
 * risk), so the responder can reference forks by title without being handed raw JSON.
 */
function renderFork(fork: ForkOption, index: number): string {
  const lines = [
    `Fork ${index + 1}: ${fork.title}${fork.recommended ? ' (you recommended this)' : ''}`,
  ]
  if (fork.summary.trim()) lines.push(`  Summary: ${fork.summary.trim()}`)
  if (fork.approach.trim()) lines.push(`  Approach: ${fork.approach.trim()}`)
  for (const t of fork.tradeoffs.filter((x) => x.trim())) lines.push(`  - ${t.trim()}`)
  if (fork.riskNotes?.trim()) lines.push(`  Risk: ${fork.riskNotes.trim()}`)
  return lines.join('\n')
}

/**
 * Assemble the chat responder's prompt from the fixed proposal grounding and the thread. Pure so
 * it is unit-testable without the model. The trailing instruction names the newest human message
 * as the one to answer.
 */
export function renderForkChatPrompt(grounding: ForkChatGrounding): string {
  const lines: string[] = []
  const description = grounding.description.trim()
  if (description) lines.push('Task:', description, '')
  if (grounding.seamSummary?.trim())
    lines.push(`Where the change lands: ${grounding.seamSummary.trim()}`, '')
  if (grounding.forks.length > 0) {
    lines.push('Approaches you surfaced:')
    grounding.forks.forEach((f, i) => lines.push(renderFork(f, i)))
    lines.push('')
  }
  const priorTurns = grounding.chat.slice(0, -1)
  const latest = grounding.chat[grounding.chat.length - 1]
  if (priorTurns.length > 0) {
    lines.push('Conversation so far:')
    for (const m of priorTurns) {
      lines.push(`${m.role === 'human' ? 'Human' : 'You'}: ${m.text.trim()}`)
    }
    lines.push('')
  }
  lines.push(
    latest
      ? `The human asks: ${latest.text.trim()}`
      : 'The human is asking about these approaches.',
    'Answer them directly and comparatively in a few sentences.',
  )
  return lines.join('\n')
}
