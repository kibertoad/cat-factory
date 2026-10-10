// The port the harness's own job HTTP server binds inside the job container, and the one fact
// about it the rest of the harness needs.
//
// It is its own module because two unrelated things read it: `harness-server.ts`, which binds it,
// and `environment-inventory.ts`, which STATES it to the agent. Reading it back off the server
// module would make the inventory import the process that imports the agent.

/**
 * The default in-container port, and deliberately NOT 8080.
 *
 * The harness is PID 1 of the job container and shares the network namespace with everything the
 * agent starts, so whatever port it holds is a port the agent cannot have. On 8080 that collision
 * was not merely inconvenient, it was a WRONG ANSWER: 8080 is the most common default for a
 * containerised HTTP service, so a service under test started there died with `EADDRINUSE`, and a
 * tester that then probed `http://127.0.0.1:8080/health` got a 200 from the harness whose body
 * begins `{"status":"ok"}`. Every ordinary health assertion (a substring match, `status === 'ok'`,
 * a 200-check) passes against the platform instead of the product, and the run is graded green on
 * a service that never started.
 *
 * The value is arbitrary within three constraints, and only the constraints matter:
 *
 *   - above 1023, since the harness runs unprivileged;
 *   - nowhere near the ports a developer or an agent reaches for by habit (3000, 4173, 5000, 8000,
 *     8080, 8081, 8443, 8888, 9000, …), which is what rules out the whole low band;
 *   - below 32768, the floor of Linux's default ephemeral range, so an OUTBOUND connection from
 *     the agent's own processes can never already hold it when the harness starts.
 *
 * Changing it is an image change: the transports address the harness at
 * `@cat-factory/contracts`' `HARNESS_JOB_PORT`, which `harness-contract.conformity.test.ts` pins
 * to this number, and a deployment's own runner pool publishes it pod-side.
 */
export const DEFAULT_HARNESS_PORT = 27182

/**
 * The port this process actually listens on: `PORT` when the deployment sets one (the native local
 * transport picks an ephemeral port per harness process and passes it that way), else the default.
 */
export function harnessListenPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PORT ?? DEFAULT_HARNESS_PORT)
}
