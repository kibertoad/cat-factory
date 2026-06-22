import * as v from 'valibot'

// Wire contracts for the email/password + invite auth flows. OAuth flows are pure
// browser redirects, so they need no request body schema.

export const signupSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
  password: v.pipe(v.string(), v.minLength(8), v.maxLength(200)),
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  /** Optional invitation token to redeem on signup (grants org membership). */
  invite: v.optional(v.pipe(v.string(), v.minLength(1))),
})
export type SignupInput = v.InferOutput<typeof signupSchema>

export const passwordLoginSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
  password: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
})
export type PasswordLoginInput = v.InferOutput<typeof passwordLoginSchema>

/** What `GET /auth/config` reports so the SPA renders the right login controls. */
export interface AuthProvidersConfig {
  enabled: boolean
  providers: { github: boolean; password: boolean; google: boolean }
}
