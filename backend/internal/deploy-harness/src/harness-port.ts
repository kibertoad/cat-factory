// The port this harness's job HTTP server binds inside the deploy container.
//
// The deploy image speaks the SAME job protocol as the executor image and is addressed by the
// same transports, which resolve one port for both (`HARNESS_JOB_PORT` in
// `@cat-factory/contracts`, mirrored by the executor harness's own `src/harness-port.ts`). So
// this number is not independently chosen: it moves with those, or a deploy dispatch reaches
// nothing. `test/harness-port.conformity.test.ts` pins it.

/**
 * The default in-container port, and deliberately NOT 8080.
 *
 * A harness is PID 1 of its container and shares the network namespace with everything the job
 * starts, so a port it holds is a port that job cannot have. On 8080 the executor harness both
 * took the port a containerised service defaults to and ANSWERED that service's health check
 * with a 200 whose body begins `{"status":"ok"}`, which is a test grading the platform instead
 * of the product. The rationale in full, and the constraints this value satisfies, live in the
 * executor harness's `src/harness-port.ts`.
 */
export const DEFAULT_HARNESS_PORT = 27182
