import type { AgentRunContext } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The design-picture CEILING of a consensus panel, the sibling of `toolServers.ts` and there for
// the same reason: a diverted step loses a capability the SAME step with consensus off would have
// had, and no layer below can see that it did.
//
// A panel's participants share ONE composed prompt string. The strategies call `generateText` with
// `prompt: goalPrompt`, so there is no message array to hang an image part on; and the participants
// run on models a workspace picked for their DISAGREEMENT, which need not agree about image input,
// so even a per-participant attachment would have to settle a verdict the one shared prompt could
// not state. Teaching the panel to carry pictures is therefore a real slice (per-participant
// content parts plus a per-participant verdict), not a line here.
//
// What must not happen meanwhile is silence. `architect` carries the `design-images` trait and is
// consensus-eligible by default, so the commonest panel on a task with a linked design is exactly
// the one that would otherwise be told neither that pictures exist nor that they were withheld,
// leaving the agent reading the textual description as everything the platform had, which is the
// state this whole feature exists to end.
// ---------------------------------------------------------------------------

/**
 * State that this panel is not showing the pictures its step resolved.
 *
 * Returns a spread-ready patch so the caller gains no branch: empty for a step whose task links no
 * design, which is most of them, and which must compose a byte-for-byte unchanged prompt.
 *
 * The set itself is kept rather than dropped. `designImagesSection` renders the views BY NAME under
 * a refusal, and a run that says "this task has design pictures I could not show you, for these six
 * views" tells the agent something it can act on (work from the textual layout of exactly those
 * screens); one that says nothing leaves it to assume the design covers what it happens to see.
 */
export function panelDesignImageCeiling(
  context: AgentRunContext,
): Pick<AgentRunContext, 'designImageDelivery'> {
  if (!context.designImages?.files.length) return {}
  return { designImageDelivery: { attached: false, reason: 'consensus_panel' } }
}
