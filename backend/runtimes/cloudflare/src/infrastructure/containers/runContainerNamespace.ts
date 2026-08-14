import { UnavailableError } from '@cat-factory/kernel'
import type { RunnerImageVariant } from '@cat-factory/kernel'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { DeployContainer } from './DeployContainer'
import type { ExecutionContainer } from './ExecutionContainer'
import type { UiTesterContainer } from './UiTesterContainer'

/**
 * Any per-run container class. The three exist only because a Cloudflare Container's image is
 * pinned per container CLASS by the wrangler `[[containers]]` block; each serves the same
 * `/jobs` HTTP contract and the same `RunContainer` lifecycle, so a namespace of any of them
 * drives the same transport.
 */
export type RunContainerNamespace =
  | DurableObjectNamespace<ExecutionContainer>
  | DurableObjectNamespace<DeployContainer>
  | DurableObjectNamespace<UiTesterContainer>

/**
 * Picks the container class that serves an image variant. A transport built for ONE class (the
 * deploy path) ignores the variant; the agent path routes `ui` to its own class.
 *
 * It THROWS for a variant this deployment has not wired, and that refusal is the point. The
 * alternative, falling back to the default class, is what this seam exists to stop: a
 * browser-driven tester silently lands on an image with no browser, pays for a checkout, an
 * install and the model's first turns, then reports an `abort` a reader cannot tell apart from
 * an app that would not boot. Refusing costs one dispatch and names the binding to add.
 */
export type ResolveRunContainerNamespace = (variant: RunnerImageVariant) => RunContainerNamespace

/** The `details.reason` a refused image variant carries, for the SPA and the run record alike. */
export const RUNNER_IMAGE_UNWIRED_REASON = 'runner_image_unwired'

/**
 * The agent path's resolver: the plain executor class for everything, the UI class for the `ui`
 * variant (today only `tester-ui` declares it).
 *
 * `deploy` never reaches here. The deploy adapter builds its own dedicated transport over
 * `DEPLOY_CONTAINER`, so a `deploy` variant arriving on the AGENT path is a wiring mistake in a
 * kind's registration rather than a missing binding. It is refused too, and separately, because
 * the two need different fixes: one is an operator adding a binding, the other a developer
 * correcting a registry entry.
 */
export function agentContainerNamespace(bindings: {
  exec: DurableObjectNamespace<ExecutionContainer>
  ui?: DurableObjectNamespace<UiTesterContainer>
}): ResolveRunContainerNamespace {
  return (variant) => {
    if (variant === 'ui') {
      if (bindings.ui) return bindings.ui
      throw new UnavailableError(
        'This step runs on the UI-tester executor image (Playwright + a browser), but this ' +
          'deployment binds no UI-tester container class, so there is nothing to dispatch it to. ' +
          'Add a `[[containers]]` class named UiTesterContainer pinned to the published ' +
          'cat-factory-executor-ui image plus its UI_CONTAINER durable-object binding, then ' +
          'redeploy. Until then, drop the `tester-ui` step from the pipeline: the ' +
          'visual-confirmation gate still runs on screenshots a person uploads.',
        RUNNER_IMAGE_UNWIRED_REASON,
        { image: variant, binding: 'UI_CONTAINER' },
      )
    }
    if (variant === 'deploy') {
      throw new UnavailableError(
        'An agent step declared the `deploy` executor image, which the agent runner path does ' +
          'not serve: deploy jobs run through the environment-provisioning adapter and its own ' +
          'DEPLOY_CONTAINER transport. Correct the agent kind’s registration.',
        RUNNER_IMAGE_UNWIRED_REASON,
        { image: variant, binding: 'DEPLOY_CONTAINER' },
      )
    }
    return bindings.exec
  }
}
