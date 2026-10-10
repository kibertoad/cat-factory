// ---------------------------------------------------------------------------
// The executor-harness job server's address inside a job container.
//
// Every transport that dispatches a job has to know the port the harness binds, and so does
// anything that must NOT collide with it (the frontend serve port, a runner pool's pod spec).
// This is that number, once: it was previously copied into the local container runtime, the
// Kubernetes pool defaults, the Cloudflare container class and the frontend serve-port guard,
// which is four places to miss when it moves.
// ---------------------------------------------------------------------------

/**
 * The in-container port the executor-harness listens on (`PORT` overrides it pod-side).
 *
 * A DELIBERATE DUPLICATE of `DEFAULT_HARNESS_PORT` in the harness's own `src/harness-port.ts`:
 * the published image builds from `src/` plus typescript and can depend on no workspace package.
 * `executor-harness/test/harness-contract.conformity.test.ts` pins the two together.
 *
 * Deliberately not 8080. The harness is PID 1 of the job container and shares its network
 * namespace with everything the agent starts, so a service under test that defaulted to 8080
 * could not bind, and a health check aimed at 8080 got a 200 from the harness whose body begins
 * `{"status":"ok"}` — the platform grading itself green in place of the product. The harness's
 * own source carries the constraints the replacement satisfies.
 */
export const HARNESS_JOB_PORT = 27182
