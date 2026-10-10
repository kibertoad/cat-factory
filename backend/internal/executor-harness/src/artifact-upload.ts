import { registerKnownSecrets } from './redact.js'

// ---------------------------------------------------------------------------
// The OUTBOUND half of the platform's own artifact seam: where a job that PRODUCES bytes sends
// them, as the two environment variables the producing prompt already names.
//
// The inbound half (`context-manifests.ts`) downloads the artifacts a run was handed. This is the
// return leg, and it stayed unwired long after its backend was done: `ContainerAgentExecutor` has
// injected `artifactUpload` into the job body and `harnessArtifactController` has served
// `POST <proxyBaseUrl>/artifacts/ingest` since the visual-confirmation work, while the harness
// parsed neither — so the `tester-ui` prompt referenced `ARTIFACT_UPLOAD_URL` at a container where
// nothing ever set it, and every screenshot a UI run captured was dropped without an error.
//
// Deliberately NOT a `switch (agentKind)`: which kinds get the seam is the BACKEND's decision (it
// keys off the kind's declared `ui` image), and the container's whole job is to pass through what
// the body carries. A harness-side kind list would be the same decision made twice, in the half
// that cannot see the registry.
// ---------------------------------------------------------------------------

/**
 * Where this job uploads the artifacts it produces, and the credential to do it with.
 *
 * The token is the run's EXISTING container session token, not a second credential: the ingest
 * route authenticates it the same way the LLM proxy does and scopes the stored bytes to that
 * token's workspace + execution. So a body carrying this grants no reach the job did not already
 * have, which is why it needs no allow-list of its own beyond the transport check below.
 */
export interface ArtifactUploadSpec {
  /** Absolute http(s) URL of the ingest endpoint. */
  url: string
  /** Bearer credential — the run's container session token. */
  token: string
}

/** The env var naming the ingest endpoint, as the producing prompts already reference it. */
export const ARTIFACT_UPLOAD_URL_ENV = 'ARTIFACT_UPLOAD_URL'
/** The env var carrying the ingest credential. */
export const ARTIFACT_UPLOAD_TOKEN_ENV = 'ARTIFACT_UPLOAD_TOKEN'

/**
 * Parse the job body's upload seam, or undefined when absent/unusable.
 *
 * The whole spec is dropped when either half is unusable, exactly as `parseImageManifest` drops a
 * manifest whose transport half is: a URL with no token and a token with no URL are both
 * an endpoint nothing can call, and the agent is told the capability is absent rather than handed
 * half of it. Absent is the NORMAL case — only a kind the backend gave a browser image to ever
 * receives one.
 */
export function parseArtifactUpload(value: unknown): ArtifactUploadSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  const url = typeof o.url === 'string' ? o.url.trim() : ''
  const token = typeof o.token === 'string' ? o.token : ''
  if (!url || !token || !/^https?:\/\//i.test(url)) return undefined
  return { url, token }
}

/**
 * Project the seam into the agent's child env, registering the credential for redaction first.
 *
 * Returns the env rather than writing `process.env`, for the reason every other per-job value here
 * does: the native host transport serves every concurrent ambient job from ONE process, so a
 * global would hand one job's ingest credential to a sibling. Absent spec ⇒ `{}`, which is what
 * makes the capability's absence visible to the agent as an unset variable (the prompts that use
 * it already branch on that) rather than as an endpoint that 401s.
 */
export function artifactUploadEnv(spec: ArtifactUploadSpec | undefined): Record<string, string> {
  if (!spec) return {}
  registerKnownSecrets([spec.token])
  return { [ARTIFACT_UPLOAD_URL_ENV]: spec.url, [ARTIFACT_UPLOAD_TOKEN_ENV]: spec.token }
}
