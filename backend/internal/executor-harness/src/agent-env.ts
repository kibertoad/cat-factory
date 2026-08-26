// The environment the harness hands to everything it spawns INTO the agent's checkout: the agent
// CLI itself, the captured commands (dependency prepopulation, validation checks, the reproduction
// proof) and the frontend build/serve.
//
// The rule this exists for: the harness process and the agent's checkout are two different
// programs, and a few of the harness's own environment variables are actively wrong for the
// second. `NODE_ENV=production` is the one that bit: npm reads it as `omit=dev`, so `npm install`
// in a checkout silently skips devDependencies, leaving the agent with no test runner, no linter
// and no build tool. One measured coder run spent six of its forty budgeted tool calls
// discovering and undoing that (install, `npm ls`, `npm config get omit`, reinstall with
// `--include=dev`, re-check the bin directory, approve an install script) — all of it caused by a
// variable the platform set, on a project the platform knows nothing about.
//
// Stripping it at THIS seam rather than in the image is what makes it true everywhere: the
// container gets `NODE_ENV=production` from `entrypoint.sh` (so the harness itself still runs in
// production mode) and the native host transport sets the same variable on the harness process it
// spawns, so an image-only fix would have left the developer's own machine leaking it.
//
// Per-job env NEVER goes through `process.env` (CLAUDE.md, "Harness rules"): the native transport
// serves every concurrent `ambientAuth` job from one long-lived process, so a mutation here would
// be a cross-job leak. This function only READS the process env and returns a fresh object.

/**
 * Variables of the HARNESS PROCESS that must not reach the agent's checkout.
 *
 * Deliberately short, and it stays short: the bar is a variable whose value is a fact about the
 * harness that a tool in the checkout will silently act on. It is not a sandbox (an agent can set
 * whatever it likes in its own shell) and not a secret filter (the harness holds per-job secrets
 * in `agentEnv`, never in `process.env`).
 */
export const HARNESS_ONLY_ENV_NAMES: readonly string[] = ['NODE_ENV']

/**
 * The child env for a command run in the agent's checkout: the harness's own environment minus
 * {@link HARNESS_ONLY_ENV_NAMES}, with each layer merged over it in order.
 *
 * A layer may still SET a stripped name — a job that explicitly asks for `NODE_ENV` gets it. The
 * strip removes what was merely INHERITED, which is the thing nobody chose.
 */
export function agentChildEnv(
  ...layers: (Record<string, string | undefined> | undefined)[]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of HARNESS_ONLY_ENV_NAMES) delete env[name]
  for (const layer of layers) {
    if (layer) Object.assign(env, layer)
  }
  return env
}
