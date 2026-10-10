import * as v from 'valibot'
import { descriptorFieldSchema, descriptorFieldValuesSchema } from './form-fields.js'
import { workspaceRoleSchema } from './workspace-members.js'

// ---------------------------------------------------------------------------
// PER-STEP GATE CONFIGURATION.
//
// A pipeline's human checkpoints were a bare `gates: boolean[]` — the step either paused for
// "a human" or it did not. There was nowhere to say WHICH humans, HOW MANY of them, or what a
// registered gate's own knobs should be for THIS step, so every gate's parameters had to be
// hard-coded in the engine (or lifted into the workspace-wide merge preset, which is the wrong
// grain: a preset is per task, a gate is per step).
//
// This module is the config that rides beside the flag, on the extensible `StepOptions` bag
// (`stepOptions[i].gateConfig`), so it needs no column and no migration. It carries two
// deliberately different halves:
//
//   - The PLATFORM-ENFORCED half ({@link gateApproverPolicySchema} + `minApprovals`). Who may
//     resolve the step's human approval gate, and how many distinct approvals advance the run.
//     Typed here rather than left opaque because the BACKEND enforces it and the SPA renders
//     it: both have to agree about what an approver set means.
//   - The GATE-DECLARED half (`fields`). A bag validated against the descriptor form the gate
//     itself registered (`GateRegistry.register(kind, factory, { configFields })`), so a
//     deployment's own gate carries its own parameters without the platform learning them.
//     This is the "ambient" part: the authoring form, the validation and the runtime all derive
//     from that ONE declaration. It rides the repo's existing descriptor-form vocabulary
//     (`form-fields.ts`) rather than a gate-only schema language, so a gate's config form is
//     collected, validated, frozen and rendered by exactly the machinery an initiative preset's
//     form and a custom task type's brief already use.
//
// Design record: `backend/docs/adr/0038-per-step-gate-config.md`.
// ---------------------------------------------------------------------------

/**
 * The most approvals one gate may demand. A bound rather than an open number because the quorum
 * is counted against DISTINCT workspace identities: a pipeline asking for more approvers than a
 * board plausibly has is a run that parks forever, and the author gets told at save time instead
 * of discovering it mid-delivery.
 */
export const MAX_GATE_APPROVALS = 10

/**
 * WHO may resolve a step's human approval gate (approve / request changes / reject).
 *
 * Both axes are ADDITIVE — an actor qualifies by holding a listed role OR by being a listed
 * user — because the two express different intents ("any admin" vs "these two people") and a
 * policy routinely wants both. An absent/empty policy means today's behaviour: anyone the
 * workspace RBAC gate already admitted to write (member and above) may resolve the gate.
 *
 * This NARROWS the member tier; it never widens anything. A viewer still cannot resolve a gate
 * (the RBAC write floor refuses the request before this is consulted), and a workspace `admin`
 * is always permitted regardless of what the policy lists — an admin can cancel the run or edit
 * the pipeline outright, so denying them here would buy no safety and would deadlock a run whose
 * named approvers have left the board.
 */
export const gateApproverPolicySchema = v.object({
  /** Workspace roles whose holders may resolve the gate. Absent/empty ⇒ no role rule. */
  roles: v.optional(v.array(workspaceRoleSchema)),
  /** Specific workspace members (`usr_*`) who may resolve the gate. Absent/empty ⇒ no user rule. */
  userIds: v.optional(v.array(v.string())),
})
export type GateApproverPolicy = v.InferOutput<typeof gateApproverPolicySchema>

/**
 * A step's gate configuration, stored at `stepOptions[i].gateConfig`.
 *
 * Every field is optional and absent means the shipped default, so a pipeline that configures
 * nothing persists no `gateConfig` at all and behaves exactly as it did before this existed.
 */
export const stepGateConfigSchema = v.object({
  /**
   * Who may resolve this step's human approval gate. Ignored (and refused at pipeline save) on a
   * step that carries no approval gate — a policy on an ungated step reads as a checkpoint that
   * silently does not exist.
   */
  approvers: v.optional(gateApproverPolicySchema),
  /**
   * How many DISTINCT permitted approvals the gate needs before the run advances. Absent ⇒ 1
   * (today's behaviour). Each approval is recorded on the gate; a second approval from the same
   * identity replaces the first rather than counting twice.
   *
   * A quorum above 1 needs identities to count, so it is only meaningful on a deployment with
   * authentication enabled: with auth off every caller is the same unattributed actor and the
   * gate would never reach two.
   */
  minApprovals: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_GATE_APPROVALS)),
  ),
  /**
   * The step's parameters for its own REGISTERED gate kind (a `ci` / `conflicts` /
   * `post-release-health` step, or a deployment's own gate), validated at pipeline save and at
   * run start against the descriptor fields that gate registered. Threaded onto the live gate
   * state, so a gate reads its knobs off the STEP instead of the engine or the workspace merge
   * preset.
   *
   * Refused at save on a step whose kind registers no gate, and on a field the gate does not
   * declare: an unread key is indistinguishable from a typo'd one, and both look to whoever
   * typed them like configuration that took effect.
   */
  fields: v.optional(descriptorFieldValuesSchema),
})
export type StepGateConfig = v.InferOutput<typeof stepGateConfigSchema>

/**
 * A registered gate's own config form, as projected to the SPA on the workspace snapshot: the
 * gate's step `kind` plus the descriptor fields it declared. The pipeline builder renders these
 * through the SAME `DescriptorFields` component every other descriptor form uses, so a
 * deployment's gate gets an authoring form with no frontend change — the "ambient" half of the
 * per-step gate config.
 *
 * Absent from the snapshot when no registered gate declares any fields, so the stock product
 * carries nothing.
 */
export const gateConfigFormSchema = v.object({
  /** The step `agentKind` this gate is registered for. */
  kind: v.string(),
  /** The gate's declared parameters (deployment-authored English labels, rendered verbatim). */
  fields: v.array(descriptorFieldSchema),
})
export type GateConfigForm = v.InferOutput<typeof gateConfigFormSchema>

/**
 * One recorded approval on a gate: who cleared it and when. Kept as a list rather than a count
 * so a quorum can be counted against DISTINCT identities (re-clicking approve is idempotent) and
 * so the run detail can name the people who signed off rather than showing an anonymous tally.
 *
 * `actorId` is a `usr_*` id for a signed-in person, the public-API key id for an integration, and
 * {@link UNATTRIBUTED_GATE_ACTOR} on a deployment running with auth disabled — three cases the
 * quorum treats identically (one slot each) and the UI labels differently.
 */
export const gateApprovalRecordSchema = v.object({
  actorId: v.string(),
  /** Display label snapshotted at approval time (login/name, or the key's label). */
  actorLabel: v.optional(v.string()),
  /** Epoch ms the approval was recorded. */
  at: v.number(),
})
export type GateApprovalRecord = v.InferOutput<typeof gateApprovalRecordSchema>

/**
 * The actor id recorded when a deployment resolves a gate with no workspace identity behind the
 * request (auth disabled). Named rather than an empty string so a reader can tell "nobody was
 * signed in" from "the field was never written", and so every such approval collapses onto ONE
 * quorum slot instead of silently satisfying a multi-approver gate.
 */
export const UNATTRIBUTED_GATE_ACTOR = 'unattributed'
