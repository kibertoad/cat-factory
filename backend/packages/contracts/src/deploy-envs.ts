import * as v from 'valibot'
import { teardownConfirmationSchema } from './environments.js'

// The per-frame environment bookkeeping a run's `deployer` and `disposer` steps carry on
// `PipelineStep` — the two ends of the ephemeral-environment lifecycle plus the readiness
// wait between them. Split out of `execution.ts` (which composes them into the step schema)
// so the step file stays within its size budget, the way `deploy-fix.ts` already does for the
// deployer's remediation loop.

/**
 * The TERMINAL per-frame outcome of one environment a `deployer` step provisioned during a
 * multi-env fan-out (the task's own service frame + every involved-service frame): `ready`
 * (a live env, `url` set), `failed` (the provision broke, `error` carries the cause), or
 * `skipped` (the frame is `infraless`, nothing stood up). The IN-FLIGHT frame is not recorded
 * here — it lives on `step.jobId`/`step.deployFrameId` until it settles. See
 * {@link pipelineStepSchema.entries.deployEnvs}.
 */
export const deployEnvStateSchema = v.object({
  status: v.picklist(['ready', 'failed', 'skipped']),
  /** The provisioned URL for a `ready` env (absent for `failed`/`skipped`). */
  url: v.optional(v.nullable(v.string())),
  /**
   * The registry id of the environment this frame got, recorded at the moment the deployer
   * resolved its handle: for a `ready` env, and for a `failed` one where the provision got far
   * enough to have a record to fail against (a `failed` env row is persisted and projected, so
   * naming it is what lets a reader tell the environment this frame broke on from a second one
   * nothing accounts for). It stays absent where the provision broke before any handle existed.
   *
   * This is the RUN's own record of WHICH environment it stood up, and it exists so that the
   * `disposer` at the other end of the lifecycle can reclaim exactly that one. Re-resolving the
   * environment from the frame later is not equivalent and is not safe: the block-and-frame read
   * falls back to the block's FRAME-LESS row (a manual or `human-test` environment) when the
   * frame's own row is gone, so a disposer running after a supersede, an operator's Destroy or a
   * TTL sweep would resolve — and destroy — an environment this run never provisioned.
   *
   * Absent on a `ready` frame means the deploy predates this field, and the disposer reports that
   * it could not identify the environment rather than guessing at one.
   */
  environmentId: v.optional(v.nullable(v.string())),
  /** The verbatim provider error for a `failed` env. */
  error: v.optional(v.nullable(v.string())),
})
export type DeployEnvState = v.InferOutput<typeof deployEnvStateSchema>

/** Per-frame deploy outcomes keyed by service-frame block id; see {@link deployEnvStateSchema}. */
export const deployEnvsSchema = v.record(v.string(), deployEnvStateSchema)
export type DeployEnvs = v.InferOutput<typeof deployEnvsSchema>

/**
 * The TERMINAL per-frame outcome of one environment a `disposer` step reclaimed, the mirror of
 * {@link deployEnvStateSchema} at the other end of the lifecycle:
 *  - `reclaimed`:  the environment was torn down. `confirmation` says whether an independent
 *                   probe then found it gone — only `confirmed` is proof (see
 *                   {@link teardownConfirmationSchema}).
 *  - `failed`:     the provider refused to tear it down; `error` carries the verbatim cause. The
 *                   environment is still standing and the TTL sweep is the remaining backstop.
 *  - `none`:       the frame had no live environment to reclaim (it was never provisioned, or
 *                   something already took it). Recorded rather than omitted, so a disposer that
 *                   found nothing is distinguishable from one that never reached the frame.
 *
 * `confirmation` is present only on `reclaimed`: the other two states have nothing to verify.
 */
export const disposeEnvStateSchema = v.object({
  status: v.picklist(['reclaimed', 'failed', 'none']),
  /** The environment id acted on, when there was one — the id an operator greps the logs for. */
  environmentId: v.optional(v.nullable(v.string())),
  /** Whether an independent probe confirmed the environment gone; `reclaimed` only. */
  confirmation: v.optional(v.nullable(teardownConfirmationSchema)),
  /** The verbatim provider error for a `failed` reclaim, or the probe's reason when it could
   *  not confirm one that otherwise succeeded. */
  error: v.optional(v.nullable(v.string())),
})
export type DisposeEnvState = v.InferOutput<typeof disposeEnvStateSchema>

/** Per-frame dispose outcomes keyed by service-frame block id; see {@link disposeEnvStateSchema}. */
export const disposeEnvsSchema = v.record(v.string(), disposeEnvStateSchema)
export type DisposeEnvs = v.InferOutput<typeof disposeEnvsSchema>

/**
 * A `deployer` step's live wait for one frame's environment to actually become READY.
 *
 * A provider whose `provision()` is asynchronous — which is what every real per-PR environment
 * backend is — answers with the environment still `provisioning` and no URL. That answer is not
 * a terminal outcome, so it is not a {@link deployEnvStateSchema} entry: the step parks here and
 * re-reads the provider's own `status()` between driver sleeps until the environment reaches
 * `ready` (recorded as the frame's outcome), reaches a terminal not-ready state, or outlives
 * {@link ENVIRONMENT_READY_TIMEOUT_MS} (recorded as a `failed` outcome naming the timeout).
 *
 * Absent whenever no frame is waiting. It is what a durable replay re-attaches the wait from,
 * which is why the environment's id is pinned here rather than re-resolved from the frame: the
 * block-and-frame read falls back to a frame-less row, so a re-resolution could poll — and then
 * report on — an environment this run never provisioned.
 */
export const deployWaitStateSchema = v.object({
  /** The service frame whose environment the step is waiting on. */
  frameId: v.string(),
  /** The registry id of the environment being polled. */
  environmentId: v.string(),
  /** When the wait began (epoch ms), the anchor the readiness deadline is measured from. */
  startedAt: v.number(),
  /** How many provider status reads the wait has made, for the step's waiting summary. */
  polls: v.number(),
})
export type DeployWaitState = v.InferOutput<typeof deployWaitStateSchema>
