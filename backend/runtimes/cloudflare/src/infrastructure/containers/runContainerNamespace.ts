import {
  deploymentImageVariantMessage,
  RUNNER_IMAGE_UNWIRED_REASON as UNWIRED_REASON,
  UnavailableError,
} from '@cat-factory/kernel'
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

/**
 * The `details.reason` a refused image variant carries, for the SPA and the run record alike.
 * Re-exported from kernel, where the other two backends raise the same refusal.
 */
export const RUNNER_IMAGE_UNWIRED_REASON = UNWIRED_REASON

/**
 * The prefix of a DEPLOYMENT-bound container class: a variant `pixel-tools` is served by the
 * durable-object binding `RUNNER_CONTAINER_PIXEL_TOOLS`.
 *
 * Discovered off `env` by name rather than declared as an option, because the binding IS the
 * declaration: a deployment adding its own image writes a `[[containers]]` class (a subclass of
 * the exported `RunContainer`, which is what pins an image on this runtime) plus its
 * durable-object binding, and a second registration in code would be the same fact stated twice
 * with nothing checking the two agree.
 */
export const DEPLOYMENT_CONTAINER_BINDING_PREFIX = 'RUNNER_CONTAINER_'

/** The binding name that serves a deployment's image variant. */
export function deploymentContainerBinding(variant: string): string {
  return `${DEPLOYMENT_CONTAINER_BINDING_PREFIX}${variant.toUpperCase().replace(/-/g, '_')}`
}

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
  /**
   * Every `RUNNER_CONTAINER_*` binding on this Worker's env, keyed by the variant it serves.
   * A deployment's own images, which the platform can neither enumerate nor name.
   */
  deployment?: Record<string, RunContainerNamespace>
}): ResolveRunContainerNamespace {
  return (variant) => {
    if (variant && variant !== 'default' && variant !== 'ui' && variant !== 'deploy') {
      const bound = bindings.deployment?.[variant]
      if (bound) return bound
      throw new UnavailableError(
        deploymentImageVariantMessage(
          variant,
          `a \`[[containers]]\` class plus its ${deploymentContainerBinding(variant)} durable-object binding`,
        ),
        RUNNER_IMAGE_UNWIRED_REASON,
        { image: variant, binding: deploymentContainerBinding(variant) },
      )
    }
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

/**
 * Every DEPLOYMENT-bound run-container namespace on this env, keyed by the image variant it
 * serves: `RUNNER_CONTAINER_PIXEL_TOOLS` serves `pixel-tools`.
 *
 * Read off the env by PREFIX rather than from a declared list, because the set is a deployment's
 * own and the platform can neither enumerate nor validate it: what makes a binding real is that
 * wrangler resolved it, and anything that merely LOOKS like one (a string, a queue) is skipped
 * here so it refuses at dispatch as unwired rather than throwing something unreadable deep in a
 * `get()`.
 */
export function deploymentContainerBindings(
  env: Record<string, unknown>,
): Record<string, RunContainerNamespace> {
  const bindings: Record<string, RunContainerNamespace> = {}
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(DEPLOYMENT_CONTAINER_BINDING_PREFIX)) continue
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as { get?: unknown }).get !== 'function'
    ) {
      continue
    }
    const variant = name
      .slice(DEPLOYMENT_CONTAINER_BINDING_PREFIX.length)
      .toLowerCase()
      .replace(/_/g, '-')
    if (variant) bindings[variant] = value as RunContainerNamespace
  }
  return bindings
}
