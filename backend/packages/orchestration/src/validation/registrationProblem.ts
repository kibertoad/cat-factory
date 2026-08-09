// The one shape every boot-time registration check speaks in, in a LEAF module so a check split
// into its own file can import it without importing the validator that calls it back.

/** A single problem found during validation. `error` aborts boot; `warn` is logged only. */
export interface RegistrationProblem {
  severity: 'error' | 'warn'
  code: string
  message: string
}
