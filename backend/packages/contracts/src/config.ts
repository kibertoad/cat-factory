import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Backend misconfiguration wire types.
//
// When a facade boots with a mandatory env var / binding missing or invalid, it no
// longer just dies with a terse log line — it reports a structured, human-readable
// list of what's wrong so (a) the operator sees a clear message and (b) the SPA can
// render a dedicated "backend misconfigured" screen instead of the generic
// "can't reach the backend" panel. This is the shared shape the backend emits (on
// `/auth/config`) and the SPA consumes.
//
// A `ConfigProblem` NEVER carries a secret value — only the env var's NAME, what it
// is for, and how to fill it — so it is safe to surface to the browser.
// ---------------------------------------------------------------------------

export const configProblemSchema = v.object({
  /** The env var or binding name, e.g. `DATABASE_URL` or `TELEMETRY_DB`. */
  key: v.string(),
  /** One sentence: what this variable is for / what breaks without it. */
  summary: v.string(),
  /** One sentence: how to fill it (the concrete remedy — a command, a format, a URL). */
  remedy: v.string(),
})
export type ConfigProblem = v.InferOutput<typeof configProblemSchema>

export const backendMisconfiguredSchema = v.object({
  problems: v.array(configProblemSchema),
})
export type BackendMisconfigured = v.InferOutput<typeof backendMisconfiguredSchema>
